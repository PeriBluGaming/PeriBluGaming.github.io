# Featured project screenshots

Each of the four featured project cards can show an optional screenshot. It replaces the stylised platform artwork
in the left area of the card. The card layout and height stay the same; the screenshot fills that area and fades into
the card on its right edge (top-to-bottom fade on phones, where the area sits above the text).
Without a screenshot the card shows the platform artwork as before. Screenshots appear on featured cards only, not
in "All Projects".

The visible area is a crop of your image:

| Viewport | Visible area (≈ width × height) | Ratio |
| --- | --- | --- |
| ≥ 1440 px (two columns) | 240 × 216 px | ≈ 1.1 : 1 |
| 1024 px (two columns) | 200 × 220 px | ≈ 0.9 : 1 |
| 481–1023 px (one column) | up to 272 × 216 px | ≈ 1.3 : 1 |
| ≤ 480 px (stacked) | full card width × 152 px | ≈ 2 : 1 |

Keep the main subject near the centre of the image (or set `position`, see below) so it stays visible in every
crop.

Screenshots can also come from Sanity (Studio → *Projects* → *Screenshots*, first image). A valid Sanity screenshot
takes precedence over the local file configured here; its hotspot replaces `position`. See
[sanity-setup.md](sanity-setup.md#projects-studioschematypesprojectts).

## 1. Prepare the image

| | Recommendation |
| --- | --- |
| Format | **WebP** for the published file. PNG is fine as source material, but keep it outside the repository. |
| Aspect ratio | **16:9** source. The card shows a crop of it (see the table above). |
| Size | **1280 × 720** px. Plenty for the visible area on high-density displays. |
| File size | Aim for **≤ 150 KB**. WebP quality 75–82 is usually enough. |
| Allowed types | `.webp`, `.avif`, `.png`, `.jpg` / `.jpeg` |

Converting with `cwebp` (already used by `scripts/assets/`, `brew install webp`):

```bash
# Source is already 16:9 (e.g. 1920×1080):
cwebp -q 80 -sharp_yuv -resize 1280 720 source.png -o screenshot.webp

# Source has another ratio: crop a 16:9 area first (-crop x y width height), then resize.
# Example: 1600×1200 source → crop 1600×900 starting 150 px from the top
cwebp -q 80 -sharp_yuv -crop 0 150 1600 900 -resize 1280 720 source.png -o screenshot.webp
```

## 2. Place the file

Put the file in a folder per project below `public/images/projects/`:

```text
public/images/projects/
  toystory2/        ToyStory2Recomp
  bugsbunny/        BugsBunnyLostinTimeRecomp
  yoshis-island/    SuperMarioWorld2YoshisIslandRecomp
  romm2switch/      romm2switch
```

The folders don't exist yet. Create one when you add its first screenshot.

## 3. Assign it to a featured project

Add an `image` to the project's entry in `featuredProjects` in `src/config/projects.ts`.

Example for `ToyStory2Recomp`. The file name is only an example; the file has to exist before you build:

```ts
export const featuredProjects: FeaturedEntry[] = [
  {
    repo: 'ToyStory2Recomp',
    accent: 'cyan',
    image: {
      src: '/images/projects/toystory2/widescreen.webp', // = public/images/projects/toystory2/widescreen.webp
      alt: "Buzz Lightyear exploring Andy's room in widescreen gameplay.",
      position: 'center', // optional
    },
  },
  // …
];
```

`src` is the path below `public/`, starting with `/images/projects/`. Remote URLs are not allowed.

### Disable a screenshot again

Remove the `image` property (or the whole `image: { … }` block) from the entry. The card switches back to the
platform artwork. You can leave the file in `public/images/projects/` or delete it.

## 4. Alt text

Describe what the screenshot shows, in one short sentence, as you would to someone who can't see it:

- ✅ `"Yoshi carrying Baby Mario through a colorful platforming level."`
- ✅ `"romm2switch game library interface on Nintendo Switch."`
- ❌ `"Screenshot"`, `"Image of ToyStory2Recomp"`, or the project title. The title is already read out on the card.

The alt text must not be empty.

## 5. Adjust the crop: `position`

The image always fills the art area (`object-fit: cover`), so parts of it are cropped. `position` is a CSS
[`object-position`](https://developer.mozilla.org/docs/Web/CSS/object-position) value that decides which part
stays visible:

| Value | Keeps visible |
| --- | --- |
| `'center'` (default) | the middle |
| `'left'` / `'right'` | the left / right part (most relevant in the two-column layout) |
| `'top'` / `'bottom'` | the upper / lower part (most relevant on phones) |
| `'50% 30%'` | horizontally centred, slightly above the middle |

Only keywords, percentages and lengths are accepted.

## 6. Check

```bash
npm test        # validation rules
npm run build   # fails with a clear message if a screenshot is misconfigured
npm run dev     # look at the cards
```

The build stops with `Invalid screenshot for "<repo>": …` if:

- the file is missing
- the path is outside `/images/projects/` or is a remote URL
- the file type is unsupported
- the alt text is empty
- `position` contains anything other than position values

If an image still fails to load in the browser, it hides itself and the card shows its platform artwork again,
never a broken-image icon.
