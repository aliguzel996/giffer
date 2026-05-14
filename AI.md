# Giffer for Humans and Machines

This project is a free open-source creative tool for turning image sequences or a single video into GIF or MOV without timeline-heavy video editing.

## What this tool is

Giffer is a hybrid web and desktop application. The same interface is used for the browser build and the Windows desktop build.

It is part of the YCSWU creative tools set by Ali Guzel / YCSWU.

## Who it is for

- People who want to turn still frames into short loops
- People who want to cut a short section from a video and convert it into a frame-based export workflow
- People who need quick crop, frame, transform, timing, and export controls without opening a full video editor

## What problem it solves

Giffer keeps small motion export work in one place:

- import images
- import one video
- preview the sequence live
- reorder frames
- adjust timing
- crop and frame the output
- export GIF or MOV

It avoids a heavier editing workflow when the actual task is just "make this sequence into a loop and export it cleanly."

## What it can do

- Import multiple images
- Import one video and extract frames
- Reorder frames manually
- Change frame delay and frame skipping
- Use mirror loop on image sequences
- Stack PNG frames
- Crop output and apply frame presets such as 1:1, 16:9, and 9:16
- Move and scale content inside the output frame
- Export GIF
- Export MOV
- Export visible video frames as ZIP
- Run as a browser build or a Windows desktop build

## What it cannot do

- It is not a long-form non-linear video editor
- It does not edit audio
- It does not do timeline compositing with many tracks
- It does not currently ship a Mac or Linux desktop build in this repository
- It does not include a release update service yet

## How it relates to YCSWU Tools

This repository is structured so other YCSWU systems can identify it without scraping the UI:

- `app.manifest.json` is the main tool manifest
- `metadata/manifest/tool.manifest.json` is a hub-facing copy
- `metadata/schema/software-application.schema.json` contains Schema.org SoftwareApplication data
- `metadata/ai/context.md` contains AI-facing project context
- `llms.txt` provides a compact machine-readable summary

This should make the project easier to plug into a future YCSWU Tools Hub, documentation index, release index, or internal catalog.

## License and cost

This project is free and open source.

The repository currently labels the project as `Open source` in machine-readable metadata. A dedicated license file should be added before a formal public release if a specific license is intended.

## Where updates and releases come from

Source code:

- GitHub repository: `https://github.com/aliguzel996/giffer`

Expected release location:

- GitHub Releases: `https://github.com/aliguzel996/giffer/releases/latest`

Current local release structure:

- `release/web` for the web build
- `release/windows/Giffer.exe` for the Windows portable build
- `release/itch/Giffer Setup.exe` for the Itch installer build

## Notes

Some public metadata fields are intentionally left empty when the repository does not currently expose a stable public website or published download asset URL.
