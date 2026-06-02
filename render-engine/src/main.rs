//! tb-render — headless HTML/CSS → PNG, built on Blitz.
//!
//! Protocol (matches src/session.ts `renderHTML`):
//!   stdin            full HTML document (external CSS already inlined as <style>)
//!   argv[1] argv[2]  viewport width, height in CSS px
//!   argv[3]          optional device scale factor (default 2.0 for retina-crisp output)
//!   stdout           PNG bytes
//!
//! Pipeline: html5ever parse → Stylo CSS cascade → Taffy layout → Parley text
//! → blitz-paint draw commands → Vello CPU rasterizer → PNG. This is the same
//! class of engine a real browser uses, minus the 684MB of Chromium.

use std::io::{Read, Write};

use anyrender::render_to_buffer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let width: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1280);
    let height: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(720);
    // Default to 2x so screenshots are crisp at normal screen sizes.
    let scale: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(2.0);

    let mut html = String::new();
    if std::io::stdin().read_to_string(&mut html).is_err() {
        eprintln!("tb-render: failed to read HTML from stdin");
        std::process::exit(1);
    }

    // Build the document at the requested viewport, then resolve styles + layout.
    let viewport = Viewport::new(width, height, scale, ColorScheme::Light);
    let doc_config = DocumentConfig {
        viewport: Some(viewport),
        ..Default::default()
    };
    let mut document = HtmlDocument::from_html(&html, doc_config);
    document.resolve(0.0);

    // Output buffer is the viewport scaled by the device pixel ratio.
    let render_width = (width as f32 * scale) as u32;
    let render_height = (height as f32 * scale) as u32;

    let buffer = render_to_buffer::<VelloCpuImageRenderer, _>(
        |scene| {
            paint_scene(
                scene,
                document.as_ref(),
                scale as f64,
                render_width,
                render_height,
            );
        },
        render_width,
        render_height,
    );

    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, render_width, render_height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().expect("png header");
        writer.write_image_data(&buffer).expect("png data");
    }

    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    if lock.write_all(&out).is_err() {
        std::process::exit(1);
    }
}
