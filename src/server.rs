//! The server a repository's binary builds and runs.

use std::net::{Ipv4Addr, SocketAddr};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use clap::{Args, Subcommand};
use tiny_http::Server as HttpServer;

use crate::launch::{self, Occupant};
use crate::routes;
use crate::table::App;

/// The bundle served when the repository does not supply its own.
const DEFAULT_INDEX_HTML: &str = include_str!("../assets/index.html");

/// The marker set on the detached worker process so it serves rather than
/// re-spawning itself.
const DEFAULT_CHILD_ENV: &str = "TABLE_EDITOR_CHILD";

/// The subcommand that reaches [`Server::run`], used to re-invoke the binary as
/// a detached worker.
const DEFAULT_COMMAND: &str = "web";

/// The port bound when neither the repository nor the command line names one.
const DEFAULT_PORT: u16 = 8787;

/// The arguments the editor's subcommand takes. A repository whose subcommand
/// takes arguments of its own flattens this into its own `Args` struct.
#[derive(Debug, Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct ServerArgs {
    /// Subcommand. Omit to launch (or reuse) the server, the default.
    #[command(subcommand)]
    pub command: Option<ServerCommand>,

    /// Table to open in the editor (maps to `?table=`). Defaults to the app's
    /// first table.
    pub table: Option<String>,

    /// Port to bind on 127.0.0.1. Defaults to the app's own port, so two
    /// editors on one machine do not collide.
    #[arg(long, global = true)]
    pub port: Option<u16>,

    /// Do not open a browser; just run the server.
    #[arg(long)]
    pub no_open: bool,

    /// Shut down any server already running on the port and start a fresh one
    /// (e.g. to pick up a newly built binary). Without this, an existing server
    /// for this app is reused.
    #[arg(long)]
    pub restart: bool,

    /// Development mode: serve only `/api` in the foreground (no embedded UI,
    /// no browser). Vite serves the UI and proxies `/api` here.
    #[arg(long)]
    pub api_only: bool,
}

#[derive(Debug, Subcommand)]
pub enum ServerCommand {
    /// Stop a server left running on the port (e.g. a stale detached one).
    /// Idempotent: a no-op when nothing is listening.
    Stop,
}

/// The editor's HTTP server, configured for one repository.
pub struct Server {
    app: Box<dyn App>,
    index_html: &'static str,
    child_env: &'static str,
    command: &'static str,
    default_port: u16,
    before_launch: Option<Box<dyn Fn() + Send>>,
}

impl Server {
    /// Build a server for an app.
    ///
    /// Panics when a table takes one of the reserved names, because such a
    /// table is unreachable: the control endpoints and the `stop` subcommand
    /// are matched first.
    pub fn new(app: impl App) -> Self {
        let app: Box<dyn App> = Box::new(app);
        for table in app.tables() {
            assert!(
                !routes::RESERVED_NAMES.contains(&table.route()),
                "table \"{}\" uses a reserved name; the editor reserves {}",
                table.route(),
                routes::RESERVED_NAMES.join(", ")
            );
        }

        Self {
            app,
            index_html: DEFAULT_INDEX_HTML,
            child_env: DEFAULT_CHILD_ENV,
            command: DEFAULT_COMMAND,
            default_port: DEFAULT_PORT,
            before_launch: None,
        }
    }

    /// Serve a bundle of the repository's own in place of the embedded one.
    pub fn index_html(mut self, html: &'static str) -> Self {
        self.index_html = html;
        self
    }

    /// The environment variable marking the detached worker process. A
    /// repository whose server is registered as a system service keeps its own
    /// name here, so the service entry does not have to change.
    pub fn child_env(mut self, var: &'static str) -> Self {
        self.child_env = var;
        self
    }

    /// The subcommand that reaches [`Server::run`], used when re-invoking the
    /// binary as a detached worker.
    pub fn command(mut self, command: &'static str) -> Self {
        self.command = command;
        self
    }

    /// The port to bind when the command line names none. Each app on a
    /// machine takes its own, so one editor never lands on another's port.
    pub fn default_port(mut self, port: u16) -> Self {
        self.default_port = port;
        self
    }

    /// Work to do once, in the process the user invoked, before a server is
    /// started or reused: bringing up a companion service, say. It does not run
    /// in the detached worker.
    pub fn before_launch(mut self, f: impl Fn() + Send + 'static) -> Self {
        self.before_launch = Some(Box::new(f));
        self
    }

    pub fn run(self, args: ServerArgs) -> Result<()> {
        let port = self.port(&args);
        let app = self.app.name();

        if let Some(ServerCommand::Stop) = args.command {
            return launch::stop(port, app);
        }

        // The detached worker carries the marker; it binds and serves. Handle
        // it before `before_launch` so only the user-invoked parent runs that.
        if std::env::var_os(self.child_env).is_some() {
            return self.serve(port, args.api_only);
        }

        if let Some(f) = &self.before_launch {
            f();
        }

        // Dev mode serves the API in the foreground so logs and Ctrl-C work;
        // Vite owns the UI and proxies `/api` here.
        if args.api_only {
            return self.serve(port, args.api_only);
        }

        let url = self.url(&args, port);
        let occupant = launch::occupant(port);

        if launch::serves(&occupant, app) {
            if args.restart {
                launch::request_shutdown(port);
                launch::wait_until_down(port)?;
            } else {
                self.open_if_wanted(&args, &url);
                println!("{app}: re-using server at {url}");
                return Ok(());
            }
        } else if occupant != Occupant::Vacant {
            return Err(launch::occupied(
                port,
                &occupant,
                app,
                "not starting a second one",
            ));
        }

        // Launch a detached copy of ourselves and wait until it is serving, so
        // the parent can return (this supports binding the command to a
        // double-click shortcut) and the browser never races an unbound port.
        launch::spawn_detached(self.command, self.child_env, args.table.as_deref(), port)?;
        launch::wait_until_up(port, app)?;
        self.open_if_wanted(&args, &url);
        println!("{app}: serving at {url}");
        Ok(())
    }

    /// The port to use: the one named on the command line, or the app's own.
    fn port(&self, args: &ServerArgs) -> u16 {
        args.port.unwrap_or(self.default_port)
    }

    /// Bind the port and serve until the process is shut down (by a signal or
    /// by `POST /api/shutdown`).
    fn serve(&self, port: u16, api_only: bool) -> Result<()> {
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let server = bind_with_retry(addr)?;

        for request in server.incoming_requests() {
            if let Err(e) = routes::handle(request, self.app.as_ref(), self.index_html, api_only) {
                eprintln!("request error: {e}");
            }
        }
        Ok(())
    }

    fn url(&self, args: &ServerArgs, port: u16) -> String {
        match self.opening_table(args) {
            Some(table) => format!("http://127.0.0.1:{port}/?table={table}"),
            None => format!("http://127.0.0.1:{port}/"),
        }
    }

    /// The table the browser opens on: the one named on the command line, or
    /// the app's first.
    fn opening_table<'a>(&'a self, args: &'a ServerArgs) -> Option<&'a str> {
        match args.table.as_deref() {
            Some(table) => Some(table),
            None => self.app.tables().first().map(|t| t.route()),
        }
    }

    fn open_if_wanted(&self, args: &ServerArgs, url: &str) {
        if args.no_open {
            return;
        }
        if let Err(e) = launch::open_browser(url) {
            eprintln!("could not open browser: {e}");
        }
    }
}

/// Bind, retrying briefly: after a `--restart` the previous server's socket can
/// linger for a moment before the OS frees the port.
fn bind_with_retry(addr: SocketAddr) -> Result<HttpServer> {
    let mut last_err = None;
    for _ in 0..20 {
        match HttpServer::http(addr) {
            Ok(server) => return Ok(server),
            Err(e) => {
                last_err = Some(e.to_string());
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Err(anyhow!(
        "could not bind {}: {}",
        addr,
        last_err.unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use clap::Parser;

    use super::*;
    use crate::fixture::{Clashing, Library};

    /// A binary that takes the editor's arguments unchanged.
    #[derive(Parser)]
    #[command(name = "library")]
    struct Cli {
        #[command(subcommand)]
        command: Command,
    }

    #[derive(Subcommand)]
    enum Command {
        Web(ServerArgs),
    }

    /// A binary that adds arguments of its own, the way a repository with a
    /// companion service does.
    #[derive(Parser)]
    #[command(name = "archive")]
    struct HostCli {
        #[command(subcommand)]
        command: HostCommand,
    }

    #[derive(Subcommand)]
    enum HostCommand {
        Web(WebArgs),
    }

    #[derive(Args)]
    struct WebArgs {
        #[command(flatten)]
        server: ServerArgs,

        #[arg(long)]
        no_service: bool,
    }

    fn parse(argv: &[&str]) -> ServerArgs {
        match Cli::parse_from(argv).command {
            Command::Web(args) => args,
        }
    }

    #[test]
    fn table_and_port_are_unset_when_unstated() {
        let args = parse(&["library", "web"]);
        assert!(args.table.is_none());
        assert!(args.port.is_none());
        assert!(!args.no_open);
    }

    #[test]
    fn a_named_table_and_flags_parse() {
        let args = parse(&["library", "web", "books", "--no-open", "--port", "9000"]);
        assert_eq!(args.table.as_deref(), Some("books"));
        assert_eq!(args.port, Some(9000));
        assert!(args.no_open);
    }

    #[test]
    fn stop_takes_the_port_as_a_global() {
        let args = parse(&["library", "web", "stop", "--port", "9000"]);
        assert!(matches!(args.command, Some(ServerCommand::Stop)));
        assert_eq!(args.port, Some(9000));
    }

    #[test]
    fn flattening_keeps_both_halves_of_the_arguments() {
        let HostCommand::Web(args) =
            HostCli::parse_from(["archive", "web", "books", "--no-service", "--port", "9000"])
                .command;
        assert!(args.no_service);
        assert_eq!(args.server.table.as_deref(), Some("books"));
        assert_eq!(args.server.port, Some(9000));
    }

    #[test]
    fn flattening_keeps_the_stop_subcommand() {
        let HostCommand::Web(args) =
            HostCli::parse_from(["archive", "web", "stop", "--port", "9000"]).command;
        assert!(matches!(args.server.command, Some(ServerCommand::Stop)));
        assert_eq!(args.server.port, Some(9000));
    }

    #[test]
    fn an_unstated_port_falls_back_to_the_apps_own() {
        let server = Server::new(Library::new()).default_port(8788);
        assert_eq!(server.port(&parse(&["library", "web"])), 8788);
        assert_eq!(
            server.port(&parse(&["library", "web", "--port", "9000"])),
            9000
        );
    }

    #[test]
    fn the_default_port_is_8787_until_an_app_names_its_own() {
        let server = Server::new(Library::new());
        assert_eq!(server.port(&parse(&["library", "web"])), 8787);
    }

    #[test]
    fn url_names_the_table_and_port() {
        let server = Server::new(Library::new());
        let args = parse(&["library", "web", "genres", "--port", "8788"]);
        assert_eq!(
            server.url(&args, server.port(&args)),
            "http://127.0.0.1:8788/?table=genres"
        );
    }

    #[test]
    fn url_falls_back_to_the_first_table() {
        let server = Server::new(Library::new());
        let args = parse(&["library", "web"]);
        assert_eq!(
            server.url(&args, server.port(&args)),
            "http://127.0.0.1:8787/?table=books"
        );
    }

    #[test]
    fn builders_override_the_defaults() {
        let server = Server::new(Library::new())
            .index_html("<!doctype html><title>Library</title>")
            .child_env("LIBRARY_WEB_CHILD")
            .command("edit")
            .default_port(8790);
        assert_eq!(server.index_html, "<!doctype html><title>Library</title>");
        assert_eq!(server.child_env, "LIBRARY_WEB_CHILD");
        assert_eq!(server.command, "edit");
        assert_eq!(server.default_port, 8790);
    }

    #[test]
    #[should_panic(expected = "reserved name")]
    fn a_table_may_not_take_a_reserved_name() {
        let _ = Server::new(Clashing::new());
    }

    #[test]
    fn the_server_can_be_moved_to_another_thread() {
        fn assert_send<T: Send>(_: &T) {}
        let server = Server::new(Library::new()).before_launch(|| {});
        assert_send(&server);
    }

    #[test]
    fn the_embedded_bundle_is_a_page() {
        assert!(DEFAULT_INDEX_HTML.starts_with("<!doctype html>"));
    }

    #[test]
    fn stop_does_not_run_before_launch() {
        let ran = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&ran);
        let server = Server::new(Library::new()).before_launch(move || {
            counter.fetch_add(1, Ordering::Relaxed);
        });

        // Port 1 is privileged and never has our server, so the stop is a no-op.
        server
            .run(parse(&["library", "web", "stop", "--port", "1"]))
            .unwrap();
        assert_eq!(ran.load(Ordering::Relaxed), 0);
    }
}
