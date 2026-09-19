//! The server a repository's binary builds and runs.

use std::net::{Ipv4Addr, SocketAddr};
use std::thread;
use std::time::Duration;

use anyhow::{Result, anyhow};
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

impl ServerArgs {
    /// Put the consuming app's own defaults into the help for `table` and
    /// `--port`.
    ///
    /// The two arguments default to something only the [`Server`] knows: the
    /// app's first table and the port it was built with. Help, though, is
    /// rendered by clap before `run` is ever reached, so the text has to be
    /// rewritten on the way in. Build the command, hand it here, and parse
    /// from what comes back:
    ///
    /// ```no_run
    /// # use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
    /// # use table_editor::ServerArgs;
    /// # #[derive(Parser)]
    /// # struct Cli {
    /// #     #[command(subcommand)]
    /// #     command: Command,
    /// # }
    /// # #[derive(Subcommand)]
    /// # enum Command {
    /// #     Web(ServerArgs),
    /// # }
    /// let command = ServerArgs::augment_help(Cli::command(), "books", 8788);
    /// let cli = Cli::from_arg_matches(&command.get_matches())?;
    /// # Ok::<(), clap::Error>(())
    /// ```
    ///
    /// Where the arguments sit does not matter: the whole command tree is
    /// walked. A command is rewritten only where it holds both `table` and
    /// `port` and both still carry this crate's own help, which is what
    /// flattening [`ServerArgs`] leaves behind. A repository's own `--port`
    /// on some other subcommand keeps its own wording, and so does one whose
    /// help the repository has already rewritten. Nothing but the help
    /// changes.
    pub fn augment_help(
        command: clap::Command,
        default_table: &str,
        default_port: u16,
    ) -> clap::Command {
        let table = format!(
            "Table to open in the editor (maps to `?table=`). Defaults to {default_table}."
        );
        let port = format!("Port to bind on 127.0.0.1. Defaults to {default_port}.");
        rewrite_help(command, &table, &port)
    }
}

/// The help clap derives for this crate's own `table` and `port`, which is how
/// an argument flattened from [`ServerArgs`] is told from a repository's own.
fn crate_help() -> (String, String) {
    let reference = ServerArgs::augment_args(clap::Command::new("table-editor"));
    let of = |id: &str| {
        reference
            .get_arguments()
            .find(|arg| arg.get_id() == id)
            .and_then(|arg| arg.get_help())
            .map(ToString::to_string)
            .unwrap_or_default()
    };
    (of("table"), of("port"))
}

/// Rewrite the help of `table` and `--port` on every command in the tree that
/// holds both of them with this crate's own wording.
fn rewrite_help(command: clap::Command, table: &str, port: &str) -> clap::Command {
    let (crate_table, crate_port) = crate_help();

    let subcommands: Vec<String> = command
        .get_subcommands()
        .map(|sub| sub.get_name().to_string())
        .collect();

    let help_of = |command: &clap::Command, id: &str| -> Option<String> {
        command
            .get_arguments()
            .find(|arg| arg.get_id() == id)
            .and_then(|arg| arg.get_help())
            .map(ToString::to_string)
    };

    let mut command = command;
    let ours = help_of(&command, "table").as_deref() == Some(crate_table.as_str())
        && help_of(&command, "port").as_deref() == Some(crate_port.as_str());
    if ours {
        let (table, port) = (table.to_string(), port.to_string());
        command = command
            .mut_arg("table", |arg| arg.help(table))
            .mut_arg("port", |arg| arg.help(port));
    }

    for name in subcommands {
        command = command.mut_subcommand(name, |sub| rewrite_help(sub, table, port));
    }
    command
}

/// Whether a name is one file inside `Data/` rather than a path out of it.
fn is_bare_file_name(file: &str) -> bool {
    !file.is_empty()
        && file != "."
        && file != ".."
        && !file.contains(['/', '\\'])
        && !std::path::Path::new(file).is_absolute()
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
    worker_args: Vec<String>,
    before_launch: Option<Box<dyn Fn() + Send>>,
}

impl Server {
    /// Build a server for an app.
    ///
    /// Panics when a table takes one of the reserved names, because such a
    /// table is unreachable: the control endpoints and the `stop` subcommand
    /// are matched first. Panics, too, when a table's file is not a bare name,
    /// since every file is resolved against the one `Data/` directory.
    pub fn new(app: impl App) -> Self {
        let app: Box<dyn App> = Box::new(app);
        for table in app.tables() {
            assert!(
                !routes::RESERVED_NAMES.contains(&table.route()),
                "table \"{}\" uses a reserved name; the editor reserves {}",
                table.route(),
                routes::RESERVED_NAMES.join(", ")
            );
            assert!(
                is_bare_file_name(table.data_file()),
                "table \"{}\" names the file \"{}\"; a table's file is a bare name inside Data/",
                table.route(),
                table.data_file()
            );
        }

        Self {
            app,
            index_html: DEFAULT_INDEX_HTML,
            child_env: DEFAULT_CHILD_ENV,
            command: DEFAULT_COMMAND,
            default_port: DEFAULT_PORT,
            worker_args: Vec::new(),
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

    /// Arguments to pass on to the detached worker, after the table and the
    /// port.
    ///
    /// The worker is a fresh invocation of this binary, and it is given only
    /// the table and the port, so a flag the user passed the parent does not
    /// reach it. A repository whose subcommand takes a flag the serving
    /// process needs—one naming a companion service, say—forwards it here.
    /// The worker inherits the environment either way, so a setting that
    /// already lives in a variable needs no forwarding.
    ///
    /// What is forwarded lands on the worker's command line, so each argument
    /// has to be one the editor's subcommand declares. It must be a flag and
    /// not a positional, because the table is the only positional that command
    /// line has—a forwarded positional is refused outright—and it must not
    /// repeat `--port` or the table, which are passed already. An argument
    /// that breaks these rules leaves the worker unable to parse its own
    /// command line, and the launch then fails with what the worker said.
    pub fn worker_args(mut self, args: impl IntoIterator<Item = String>) -> Self {
        self.worker_args = args.into_iter().collect();
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

        if args.restart && launch::replaceable(&occupant, app) {
            // A server that names no app is replaced but never adopted, so an
            // upgrade can take its port back.
            if occupant == Occupant::Unnamed {
                println!("{app}: replacing a server on port {port} that does not name its app");
            }
            launch::request_shutdown(port);
            launch::wait_until_down(port)?;
        } else if launch::serves(&occupant, app) {
            self.open_if_wanted(&args, &url);
            println!("{app}: re-using server at {url}");
            return Ok(());
        } else if occupant != Occupant::Vacant {
            let doing = if args.restart {
                "not replacing it"
            } else {
                "not starting a second one"
            };
            return Err(launch::occupied(port, &occupant, app, doing));
        }

        // Launch a detached copy of ourselves and wait until it is serving, so
        // the parent can return (this supports binding the command to a
        // double-click shortcut) and the browser never races an unbound port.
        let mut worker = launch::spawn_detached(
            self.command,
            self.child_env,
            args.table.as_deref(),
            port,
            &self.worker_args,
        )?;
        launch::wait_until_up(port, app, &mut worker)?;
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
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use clap::{CommandFactory, Parser};

    use super::*;
    use crate::fixture::{Clashing, Library, Straying};

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
        /// A companion service of the repository's own, with a port of its own.
        ServeSpeech(SpeechArgs),
    }

    #[derive(Args)]
    struct WebArgs {
        #[command(flatten)]
        server: ServerArgs,

        #[arg(long)]
        no_service: bool,
    }

    #[derive(Args)]
    struct SpeechArgs {
        /// Port the speech service listens on. Defaults to 8765.
        #[arg(long)]
        port: Option<u16>,
    }

    fn parse(argv: &[&str]) -> ServerArgs {
        match Cli::parse_from(argv).command {
            Command::Web(args) => args,
        }
    }

    fn host_web(argv: &[&str]) -> WebArgs {
        match HostCli::parse_from(argv).command {
            HostCommand::Web(args) => args,
            HostCommand::ServeSpeech(_) => panic!("the web subcommand"),
        }
    }

    fn help_of(command: &mut clap::Command, subcommand: &str) -> String {
        command
            .find_subcommand_mut(subcommand)
            .unwrap_or_else(|| panic!("the {subcommand} subcommand"))
            .render_help()
            .to_string()
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
        let args = host_web(&["archive", "web", "books", "--no-service", "--port", "9000"]);
        assert!(args.no_service);
        assert_eq!(args.server.table.as_deref(), Some("books"));
        assert_eq!(args.server.port, Some(9000));
    }

    #[test]
    fn flattening_keeps_the_stop_subcommand() {
        let args = host_web(&["archive", "web", "stop", "--port", "9000"]);
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
            .default_port(8790)
            .worker_args(["--no-service".to_string()]);
        assert_eq!(server.index_html, "<!doctype html><title>Library</title>");
        assert_eq!(server.child_env, "LIBRARY_WEB_CHILD");
        assert_eq!(server.command, "edit");
        assert_eq!(server.default_port, 8790);
        assert_eq!(server.worker_args, ["--no-service"]);
    }

    #[test]
    fn the_worker_is_started_with_what_the_app_forwards() {
        let server = Server::new(Library::new())
            .command("edit")
            .worker_args(["--no-service".to_string()]);
        assert_eq!(
            launch::worker_argv(server.command, Some("books"), 8790, &server.worker_args).unwrap(),
            ["edit", "books", "--port", "8790", "--no-service"]
        );
    }

    #[test]
    fn help_states_the_apps_own_defaults() {
        let mut command = ServerArgs::augment_help(Cli::command(), "books", 8788);
        let help = help_of(&mut command, "web");

        assert!(help.contains("Defaults to books."), "{help}");
        assert!(help.contains("Defaults to 8788."), "{help}");
    }

    #[test]
    fn help_reaches_arguments_a_repository_has_flattened_into_its_own() {
        let mut command = ServerArgs::augment_help(HostCli::command(), "books", 8788);
        let help = help_of(&mut command, "web");

        assert!(help.contains("Defaults to books."), "{help}");
        assert!(help.contains("Defaults to 8788."), "{help}");
        // The repository's own arguments are left as they were.
        assert!(help.contains("--no-service"), "{help}");
    }

    #[test]
    fn a_repositorys_own_port_keeps_its_own_help() {
        let mut command = ServerArgs::augment_help(HostCli::command(), "books", 8788);
        let help = help_of(&mut command, "serve-speech");

        // Clap drops the full stop a doc comment ends in; the point is that
        // this is still the repository's own sentence.
        assert!(
            help.contains("Port the speech service listens on"),
            "{help}"
        );
        assert!(help.contains("Defaults to 8765"), "{help}");
        assert!(!help.contains("Defaults to 8788"), "{help}");
        assert!(!help.contains("127.0.0.1"), "{help}");
    }

    #[test]
    fn help_a_repository_has_already_written_is_left_alone() {
        let command = Cli::command().mut_subcommand("web", |web| {
            web.mut_arg("port", |arg| arg.help("Port for the editor. Ask Ada."))
        });
        let mut command = ServerArgs::augment_help(command, "books", 8788);
        let help = help_of(&mut command, "web");

        assert!(help.contains("Ask Ada."), "{help}");
        assert!(!help.contains("Defaults to 8788."), "{help}");
        // Both arguments are judged together, so the table is left as it was.
        assert!(!help.contains("Defaults to books."), "{help}");
    }

    #[test]
    fn a_command_without_the_editors_arguments_is_left_alone() {
        let command = ServerArgs::augment_help(clap::Command::new("bare"), "books", 8788);
        assert_eq!(command.get_name(), "bare");
        assert_eq!(command.get_arguments().count(), 0);
    }

    #[test]
    #[should_panic(expected = "reserved name")]
    fn a_table_may_not_take_a_reserved_name() {
        let _ = Server::new(Clashing::new());
    }

    #[test]
    #[should_panic(expected = "bare name inside Data/")]
    fn a_tables_file_may_not_be_a_path() {
        let _ = Server::new(Straying::new());
    }

    #[test]
    fn a_bare_file_name_is_one_file_in_the_data_directory() {
        assert!(is_bare_file_name("Books.jsonl"));
        assert!(is_bare_file_name("books.with.dots.jsonl"));

        for stray in [
            "",
            ".",
            "..",
            "../Books.jsonl",
            "sub/Books.jsonl",
            r"sub\Books.jsonl",
            "/etc/passwd",
        ] {
            assert!(!is_bare_file_name(stray), "{stray}");
        }
    }

    #[test]
    fn the_server_can_be_moved_to_another_thread() {
        fn assert_send<T: Send>(_: &T) {}
        let server = Server::new(Library::new()).before_launch(|| {});
        assert_send(&server);
    }

    #[test]
    fn the_embedded_bundle_is_the_built_editor() {
        assert!(DEFAULT_INDEX_HTML.starts_with("<!doctype html>"));
        // The bundle is one self-contained page: the element the editor mounts
        // on, and its script inlined rather than fetched.
        assert!(DEFAULT_INDEX_HTML.contains(r#"<div id="root">"#));
        assert!(!DEFAULT_INDEX_HTML.contains(r#"src="/src/main.tsx""#));
        assert!(
            DEFAULT_INDEX_HTML.len() > 50_000,
            "the bundle is {} bytes, which is too small to be the built editor",
            DEFAULT_INDEX_HTML.len()
        );
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
