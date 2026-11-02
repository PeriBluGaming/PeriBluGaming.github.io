"""
Derive the optimised website assets from the local design originals.

Reads (never modifies):  design-references/periblugaming-logo.jpg
                         design-references/synthwave-background.png
Writes:                  public/images/logo-wordmark.webp
                         public/images/hero-synthwave.webp
                         public/images/hero-synthwave-640.webp
                         public/images/og-image.jpg
                         public/favicon.ico, public/favicon.png, public/apple-touch-icon.png

Usage (from the repository root):
    python3 scripts/assets/build_assets.py [--out-root DIR]

--out-root writes into DIR/public/... instead of the repository (useful for comparing).
Requirements: Python 3, Pillow, NumPy and the `cwebp` CLI (libwebp).
"""

import argparse
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance

REPO = Path(__file__).resolve().parents[2]
REFS = REPO / "design-references"

# Uniform background colour of the original logo artwork.
LOGO_BG = np.array([7.0, 7.0, 31.0])
# Crop of the logo that matches the mockup (sun + wordmark), in original pixels.
WORDMARK_BOX = (55, 180, 965, 790)
WORDMARK_EDGE_FADE = 24  # px, softens decorative lines cut by the crop


def colour_to_alpha(src: Path) -> Image.Image:
    """GIMP-style colour-to-alpha against LOGO_BG; keeps glow and original colours."""
    img = np.asarray(Image.open(src).convert("RGB")).astype(np.float64)
    d = img - LOGO_BG
    ratio = np.where(d > 0, d / (255.0 - LOGO_BG), np.where(d < 0, -d / LOGO_BG, 0.0))
    alpha = ratio.max(axis=2)

    # Suppress JPEG noise / faint vignette in the near-transparent range only.
    lo, hi = 0.035, 0.12
    t = np.clip((alpha - lo) / (hi - lo), 0, 1)
    alpha_f = np.where(alpha < hi, alpha * (t * t * (3 - 2 * t)), alpha)

    fg = np.clip((img - LOGO_BG) / np.maximum(alpha, 1e-6)[..., None] + LOGO_BG, 0, 255)
    rgba = Image.fromarray(np.dstack([fg, alpha_f * 255]).round().astype(np.uint8), "RGBA")

    # Sanity check: composited back onto the background it must reproduce the original.
    # Guards against broken NumPy builds (e.g. NumPy 1.26 on Python 3.14 miscomputes here).
    back = Image.alpha_composite(Image.new("RGBA", rgba.size, (7, 7, 31, 255)), rgba).convert("RGB")
    err = np.abs(np.asarray(back).astype(int) - img.astype(int)).mean()
    if err > 2.0:
        raise RuntimeError(f"Logo cut-out failed round-trip check (mean error {err:.2f}). Check NumPy/Python versions.")
    return rgba


def wordmark(logo_rgba: Image.Image) -> Image.Image:
    wm = np.asarray(logo_rgba.crop(WORDMARK_BOX)).astype(float)
    h, w = wm.shape[:2]
    f = WORDMARK_EDGE_FADE
    ry = np.clip(np.minimum(np.arange(h), h - 1 - np.arange(h)) / f, 0, 1)
    rx = np.clip(np.minimum(np.arange(w), w - 1 - np.arange(w)) / f, 0, 1)
    wm[..., 3] *= np.outer(ry, rx)
    return Image.fromarray(wm.round().astype(np.uint8), "RGBA")


def webp(src: Path, dst: Path, *args: str) -> None:
    subprocess.run(["cwebp", "-quiet", "-m", "6", *args, str(src), "-o", str(dst)], check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out-root", type=Path, default=REPO)
    out_root = parser.parse_args().out_root.resolve()

    pub = out_root / "public"
    images = pub / "images"
    images.mkdir(parents=True, exist_ok=True)

    logo_src = REFS / "periblugaming-logo.jpg"
    bg_src = REFS / "synthwave-background.png"

    with tempfile.TemporaryDirectory() as tmp:
        wm_png = Path(tmp) / "logo-wordmark.png"
        wm_img = wordmark(colour_to_alpha(logo_src))
        wm_img.save(wm_png)

        # Logo for header/footer
        webp(wm_png, images / "logo-wordmark.webp", "-q", "82", "-alpha_q", "90", "-resize", "360", "0")

        # Hero background: native resolution + small variant for phones
        webp(bg_src, images / "hero-synthwave.webp", "-q", "82", "-sharp_yuv")
        webp(bg_src, images / "hero-synthwave-640.webp", "-q", "78", "-sharp_yuv", "-resize", "640", "0")

        # Favicons from the original square logo (original colours, background kept for tile use)
        logo = Image.open(logo_src).convert("RGB")
        logo.resize((180, 180), Image.LANCZOS).save(pub / "apple-touch-icon.png", optimize=True)
        fav = logo.crop((150, 150, 874, 874)).resize((48, 48), Image.LANCZOS)
        fav.save(pub / "favicon.png", optimize=True)
        fav.save(pub / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

        # Open Graph image 1200x630: hero crop with dimmed backdrop and wordmark
        src = Image.open(bg_src).convert("RGB")
        w = 1200
        s = w / src.width
        scaled = src.resize((w, round(src.height * s)), Image.LANCZOS)
        cy = round(700 * s)
        og = ImageEnhance.Brightness(scaled.crop((0, cy - 315, w, cy + 315))).enhance(0.55).convert("RGBA")
        wm_og = wm_img.resize((640, round(wm_img.height * 640 / wm_img.width)), Image.LANCZOS)
        og.alpha_composite(wm_og, ((w - wm_og.width) // 2, (630 - wm_og.height) // 2))
        og.convert("RGB").save(images / "og-image.jpg", quality=85, optimize=True, progressive=True)

    print(f"Assets written to {pub}")


if __name__ == "__main__":
    main()
