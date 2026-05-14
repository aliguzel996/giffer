# Giffer AI Context

## Identity

- Project name: Giffer
- Tool name: Giffer
- Publisher: YCSWU
- Creator: Ali Guzel
- Current version: 0.1.0
- Project type: hybrid web and desktop creative tool

## Main function

Convert image sequences or a single video into GIF or MOV with live preview, timing control, crop/frame tools, transform controls, and export options.

## Supported platforms

- Web build
- Windows desktop build

## Input formats

- `image/png`
- `image/jpeg`
- `image/webp`
- `image/bmp`
- `video/mp4`
- `video/quicktime`
- `video/webm`
- `video/x-m4v`

## Output formats

- `image/gif`
- `video/quicktime`
- `application/zip` for visible video frames

## Release structure

- Repository: `https://github.com/aliguzel996/giffer`
- Latest release page: `https://github.com/aliguzel996/giffer/releases/latest`
- Local build outputs:
  - `release/web`
  - `release/windows/Giffer.exe`
  - `release/itch/Giffer Setup.exe`

## Metadata map

- Main manifest: `app.manifest.json`
- Hub-facing manifest: `metadata/manifest/tool.manifest.json`
- Schema.org data: `metadata/schema/software-application.schema.json`
- Changelog: `CHANGELOG.md`
- LLM summary: `llms.txt`

## Integration notes

- The app does not expose a dedicated public website yet.
- `downloadUrls` are intentionally empty until stable public release assets exist.
- Electron `build.appId` still uses an older identifier and should be aligned manually before a formal release if installer identity matters.
