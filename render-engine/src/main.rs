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
    // Base URL for resolving relative resource URLs. MUST be a valid absolute URL
    // with a real scheme/host, otherwise Blitz panics resolving protocol-relative
    // (`//host/...`) or relative URLs against it. Defaults to a harmless https base
    // so a single bad <img>/url() on a real page can never crash the render.
    let base_url: String = match args.get(4) {
        Some(u) if u.starts_with("http://") || u.starts_with("https://") => u.clone(),
        _ => "https://localhost/".to_string(),
    };

    let mut html = String::new();
    if std::io::stdin().read_to_string(&mut html).is_err() {
        eprintln!("tb-render: failed to read HTML from stdin");
        std::process::exit(1);
    }

    // Save the real stdout, then point fd 1 at stderr so any library chatter
    // (html5ever parse errors, etc.) can't corrupt the PNG byte stream. We write
    // the PNG to the saved fd at the end.
    let real_stdout_fd: i32 = unsafe {
        let saved = libc::dup(1);
        if saved >= 0 {
            libc::dup2(2, 1);
        }
        saved
    };

    // Build the document at the requested viewport, then resolve styles + layout.
    let viewport = Viewport::new(width, height, scale, ColorScheme::Light);
    let doc_config = DocumentConfig {
        viewport: Some(viewport),
        base_url: Some(base_url),
        ..Default::default()
    };
    let mut document = HtmlDocument::from_html(&html, doc_config);
    document.resolve(0.0);

    // Full-page mode (argv[5] == "full"): render the entire laid-out document
    // height instead of just the viewport. Capped to keep buffers sane.
    let full_page = args.get(5).map(|s| s == "full").unwrap_or(false);
    let css_height: u32 = if full_page {
        let content_h = document.as_ref().root_element().final_layout.size.height as u32;
        content_h.max(height).min(30_000)
    } else {
        height
    };

    // Output buffer is the (viewport or full content) size scaled by the DPR.
    let render_width = (width as f32 * scale) as u32;
    let render_height = (css_height as f32 * scale) as u32;

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

    // Write the PNG to the real stdout we saved before redirecting fd 1.
    use std::os::unix::io::FromRawFd;
    if real_stdout_fd >= 0 {
        let mut real_stdout = unsafe { std::fs::File::from_raw_fd(real_stdout_fd) };
        let _ = real_stdout.write_all(&out);
        let _ = real_stdout.flush();
    } else {
        let _ = std::io::stdout().write_all(&out);
    }
}
