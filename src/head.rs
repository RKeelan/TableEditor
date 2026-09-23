//! What the page's head carries: the app's name as its title, and the app's
//! icon.
//!
//! The page is one inlined file built long before any app is known, so both
//! are written into it once, when the server starts. The title is the element
//! the page already has, with the app's name in place of `Table Editor`; the
//! icon's links go where the page carries [`MARKER`]. The files the links name
//! are served from the app's [`Icon`] by [`asset`].
//!
//! The files are served at the root, but every link to them is relative, as
//! are the icons the manifest names: a repository may be served behind a
//! reverse proxy under a path prefix, where `/icon.svg` would reach the
//! proxy's root rather than the app.

use serde::Serialize;

use crate::table::App;

/// An app's icon: one drawing, and the renders of it each browser asks for.
///
/// Every field is required. Each is what some browser asks for and does
/// without where it is missing—Safari reads no SVG, and iOS and Android each
/// want a size of their own—so a partial set is an icon in one browser and not
/// in the next. The PNGs are renders of the SVG, which a script makes once.
///
/// ```
/// # use table_editor::Icon;
/// const ICON: Icon = Icon {
///     svg: b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"/>",
///     png16: &[],
///     png32: &[],
///     png180: &[],
///     png192: &[],
///     png512: &[],
///     theme_color: "#12151b",
/// };
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Icon {
    /// The drawing, with a square `viewBox`: what a browser that reads SVG
    /// puts in the tab. Served at `/icon.svg`.
    pub svg: &'static [u8],
    /// Served at `/favicon-16x16.png`, for a tab in a browser that reads no
    /// SVG.
    pub png16: &'static [u8],
    /// Served at `/favicon-32x32.png`, for the same on a high-density screen.
    pub png32: &'static [u8],
    /// Served at `/apple-touch-icon.png`, for an iOS home screen, which rounds
    /// its corners.
    pub png180: &'static [u8],
    /// Served at `/android-chrome-192x192.png` and named in the manifest, for
    /// an Android home screen.
    pub png192: &'static [u8],
    /// Served at `/android-chrome-512x512.png` and named in the manifest, for
    /// Android's splash screen.
    pub png512: &'static [u8],
    /// A CSS colour, such as `#12151b`, which a browser that reads it paints
    /// its own chrome around the page.
    pub theme_color: &'static str,
}

/// Where the page's head takes the icon's links. `Web/index.html` and
/// `assets/placeholder.html` both carry it, and a repository serving a page of
/// its own through `Server::index_html` puts it in that page's head to be
/// given them too.
pub(crate) const MARKER: &str = "<!-- table-editor:head -->";

/// The start of the title both of the crate's pages carry, which the app's
/// name replaces.
const TITLE: &str = "<title>Table Editor";

const SVG: &str = "image/svg+xml";
const PNG: &str = "image/png";
const MANIFEST: &str = "application/manifest+json";

/// The page with the app's name as its title, and the icon's links in its
/// head where the app has an icon.
///
/// A page without the marker is given no links, and one whose title does not
/// start `Table Editor` keeps its own title.
pub(crate) fn rewrite(page: &str, app: &dyn App) -> String {
    let links = app.icon().map(|icon| links(&icon)).unwrap_or_default();
    let title = format!("<title>{}", escape(app.name()));
    page.replacen(TITLE, &title, 1).replacen(MARKER, &links, 1)
}

/// The head's links to the icon's files, and the theme colour.
///
/// Each link is relative to the page, which is served at the root (`/` or
/// `/index.html`) and never leaves it: the bundle moves between tables and
/// views by the query string alone. So under a prefix, a page reached at
/// `/prefix/` finds its icon at `/prefix/icon.svg`. One reached at `/prefix`,
/// with no closing slash, resolves the links against the proxy's root instead.
fn links(icon: &Icon) -> String {
    format!(
        concat!(
            r#"<link rel="icon" type="image/svg+xml" href="icon.svg" />"#,
            r#"<link rel="icon" type="image/png" sizes="32x32" href="favicon-32x32.png" />"#,
            r#"<link rel="icon" type="image/png" sizes="16x16" href="favicon-16x16.png" />"#,
            r#"<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png" />"#,
            r#"<link rel="manifest" href="manifest.json" />"#,
            r#"<meta name="theme-color" content="{}" />"#,
        ),
        escape(icon.theme_color)
    )
}

/// Text made safe to put in an element or a quoted attribute.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The icon's file at `path`, as its content type and its bytes, or nothing
/// where the path is not one of them or the app has no icon.
pub(crate) fn asset(app: &dyn App, path: &str) -> Option<(&'static str, Vec<u8>)> {
    let icon = app.icon()?;
    let file = |content_type, bytes: &[u8]| Some((content_type, bytes.to_vec()));
    match path {
        "/icon.svg" => file(SVG, icon.svg),
        "/favicon-16x16.png" => file(PNG, icon.png16),
        "/favicon-32x32.png" => file(PNG, icon.png32),
        "/apple-touch-icon.png" => file(PNG, icon.png180),
        "/android-chrome-192x192.png" => file(PNG, icon.png192),
        "/android-chrome-512x512.png" => file(PNG, icon.png512),
        "/manifest.json" => Some((MANIFEST, manifest(app.name(), &icon).into_bytes())),
        _ => None,
    }
}

/// The web app manifest, which is where Android finds the icon for a home
/// screen. Its icons' `src` values resolve against the manifest's own
/// address, which is beside the page's.
#[derive(Serialize)]
struct Manifest<'a> {
    name: &'a str,
    short_name: &'a str,
    icons: [ManifestIcon; 2],
    theme_color: &'a str,
}

#[derive(Serialize)]
struct ManifestIcon {
    src: &'static str,
    sizes: &'static str,
    #[serde(rename = "type")]
    content_type: &'static str,
}

fn manifest(name: &str, icon: &Icon) -> String {
    let manifest = Manifest {
        name,
        short_name: name,
        icons: [
            ManifestIcon {
                src: "android-chrome-192x192.png",
                sizes: "192x192",
                content_type: PNG,
            },
            ManifestIcon {
                src: "android-chrome-512x512.png",
                sizes: "512x512",
                content_type: PNG,
            },
        ],
        theme_color: icon.theme_color,
    };
    serde_json::to_string(&manifest).expect("a manifest of strings serializes")
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::fixture::{Books, Plain};
    use crate::routes::RESERVED_NAMES;
    use crate::table::Table;

    /// Stand-ins for the icon's files: a few bytes each, told apart by
    /// content, and no image at all.
    const ICON: Icon = Icon {
        svg: b"<svg/>",
        png16: b"png16",
        png32: b"png32",
        png180: b"png180",
        png192: b"png192",
        png512: b"png512",
        theme_color: "#12151b",
    };

    struct Iconic(Books);
    impl App for Iconic {
        fn name(&self) -> &str {
            "Library"
        }
        fn tables(&self) -> Vec<&dyn Table> {
            vec![&self.0]
        }
        fn icon(&self) -> Option<Icon> {
            Some(ICON)
        }
    }

    /// Every path an icon's files are served at.
    const PATHS: [&str; 7] = [
        "/icon.svg",
        "/favicon-16x16.png",
        "/favicon-32x32.png",
        "/apple-touch-icon.png",
        "/android-chrome-192x192.png",
        "/android-chrome-512x512.png",
        "/manifest.json",
    ];

    const PAGE: &str = "<!doctype html><head><title>Table Editor</title>\
                        <!-- table-editor:head --></head>";

    #[test]
    fn an_app_with_an_icon_serves_each_of_its_files() {
        let app = Iconic(Books);
        let served = |path| asset(&app, path).expect(path);
        assert_eq!(served("/icon.svg"), (SVG, b"<svg/>".to_vec()));
        assert_eq!(served("/favicon-16x16.png"), (PNG, b"png16".to_vec()));
        assert_eq!(served("/favicon-32x32.png"), (PNG, b"png32".to_vec()));
        assert_eq!(served("/apple-touch-icon.png"), (PNG, b"png180".to_vec()));
        assert_eq!(
            served("/android-chrome-192x192.png"),
            (PNG, b"png192".to_vec())
        );
        assert_eq!(
            served("/android-chrome-512x512.png"),
            (PNG, b"png512".to_vec())
        );
        assert_eq!(served("/manifest.json").0, MANIFEST);
        assert!(asset(&app, "/favicon.ico").is_none());
        assert!(asset(&app, "/icon.png").is_none());
    }

    #[test]
    fn the_manifest_names_the_app_and_its_android_icons() {
        let (_, bytes) = asset(&Iconic(Books), "/manifest.json").unwrap();
        let manifest: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            manifest,
            json!({
                "name": "Library",
                "short_name": "Library",
                "icons": [
                    { "src": "android-chrome-192x192.png", "sizes": "192x192",
                      "type": "image/png" },
                    { "src": "android-chrome-512x512.png", "sizes": "512x512",
                      "type": "image/png" }
                ],
                "theme_color": "#12151b"
            })
        );
    }

    #[test]
    fn an_app_without_an_icon_serves_none_of_its_files() {
        for path in PATHS {
            assert!(asset(&Plain::new(), path).is_none(), "{path}");
        }
    }

    #[test]
    fn no_table_or_view_may_take_the_name_of_an_icons_file() {
        for path in PATHS {
            assert!(asset(&Iconic(Books), path).is_some(), "{path}");
            let (stem, _) = path[1..].rsplit_once('.').unwrap();
            assert!(RESERVED_NAMES.contains(&stem), "{stem}");
        }
    }

    #[test]
    fn the_page_is_titled_with_the_apps_name() {
        let page = rewrite(PAGE, &Plain::new());
        assert!(page.contains("<title>Plain</title>"), "{page}");
        assert!(!page.contains("Table Editor"));
    }

    #[test]
    fn a_page_for_an_app_with_an_icon_links_to_it() {
        let page = rewrite(PAGE, &Iconic(Books));
        for link in [
            r#"<link rel="icon" type="image/svg+xml" href="icon.svg" />"#,
            r#"<link rel="icon" type="image/png" sizes="32x32" href="favicon-32x32.png" />"#,
            r#"<link rel="icon" type="image/png" sizes="16x16" href="favicon-16x16.png" />"#,
            r#"<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png" />"#,
            r#"<link rel="manifest" href="manifest.json" />"#,
            r##"<meta name="theme-color" content="#12151b" />"##,
        ] {
            assert!(page.contains(link), "{link} is missing from {page}");
        }
        assert!(!page.contains(MARKER));
    }

    #[test]
    fn every_link_and_manifest_icon_is_relative() {
        let page = rewrite(PAGE, &Iconic(Books));
        let hrefs: Vec<&str> = page
            .split(r#"href=""#)
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap())
            .collect();
        assert_eq!(hrefs.len(), 5, "{page}");
        for href in hrefs {
            assert!(!href.starts_with('/'), "{href}");
            assert!(
                asset(&Iconic(Books), &format!("/{href}")).is_some(),
                "{href}"
            );
        }

        let (_, bytes) = asset(&Iconic(Books), "/manifest.json").unwrap();
        let manifest: Value = serde_json::from_slice(&bytes).unwrap();
        for icon in manifest["icons"].as_array().unwrap() {
            let src = icon["src"].as_str().unwrap();
            assert!(!src.starts_with('/'), "{src}");
            assert!(asset(&Iconic(Books), &format!("/{src}")).is_some(), "{src}");
        }
    }

    #[test]
    fn a_page_for_an_app_without_an_icon_has_no_links() {
        let page = rewrite(PAGE, &Plain::new());
        assert!(!page.contains("<link"), "{page}");
        assert!(!page.contains("theme-color"), "{page}");
        assert!(!page.contains(MARKER));
    }

    #[test]
    fn the_apps_name_is_escaped_in_the_title() {
        struct Marked(Books);
        impl App for Marked {
            fn name(&self) -> &str {
                "Q&A <draft>"
            }
            fn tables(&self) -> Vec<&dyn Table> {
                vec![&self.0]
            }
        }
        let page = rewrite(PAGE, &Marked(Books));
        assert!(
            page.contains("<title>Q&amp;A &lt;draft&gt;</title>"),
            "{page}"
        );
    }

    #[test]
    fn a_page_of_the_repositorys_own_keeps_its_own_title() {
        let own = "<!doctype html><title>Catalogue</title>";
        assert_eq!(rewrite(own, &Iconic(Books)), own);
    }

    #[test]
    fn the_placeholder_is_titled_and_linked_like_the_built_page() {
        let placeholder = include_str!("../assets/placeholder.html");
        assert!(placeholder.contains(MARKER));
        let page = rewrite(placeholder, &Iconic(Books));
        assert!(
            page.contains("<title>Library: bundle not built</title>"),
            "{page}"
        );
        assert!(page.contains(r#"href="icon.svg""#));
        assert!(!page.contains(MARKER));
    }
}
