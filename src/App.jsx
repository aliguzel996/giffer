import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];
const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'];
const MIN_DELAY = 20;
const MAX_DELAY = 1000;
const MIN_STEP = 1;
const MIN_MOV_FPS = 1;
const MIN_LONG_EDGE = 240;
const MIN_OPTIMIZE = 0;
const MAX_OPTIMIZE = 100;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const PREVIEW_CANVAS_WIDTH = 1280;
const PREVIEW_CANVAS_HEIGHT = 860;
const PREVIEW_SOURCE_MAX_LONG_EDGE = 1600;
const desktopApi = window.gifMakerDesktop ?? null;
const loadedImageCache = new Map();
const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let current = index;

  for (let bit = 0; bit < 8; bit += 1) {
    current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  }

  return current >>> 0;
});

function clampNumber(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(parsed, min));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function moveFrameByIds(items, sourceId, targetId) {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);

  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(sourceIndex, 1);
  nextItems.splice(targetIndex, 0, movedItem);
  return nextItems;
}

function fitRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  return {
    width,
    height,
    x: Math.round((targetWidth - width) / 2),
    y: Math.round((targetHeight - height) / 2),
  };
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return '0:00';
  }

  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;

  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function getFileExtension(name = '') {
  const lastDotIndex = name.lastIndexOf('.');
  return lastDotIndex >= 0 ? name.slice(lastDotIndex).toLowerCase() : '';
}

function filePathToUrl(filePath = '') {
  if (!filePath) {
    return '';
  }

  const normalized = filePath.replace(/\\/g, '/');
  const withPrefix = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
  return encodeURI(withPrefix);
}

function getFrameAspect(preset) {
  if (preset === '1:1') {
    return 1;
  }

  if (preset === '16:9') {
    return 16 / 9;
  }

  if (preset === '9:16') {
    return 9 / 16;
  }

  return null;
}

function createCenteredFrame(preset, canvasWidth, canvasHeight) {
  const aspect = getFrameAspect(preset) ?? canvasWidth / canvasHeight;
  const canvasAspect = canvasWidth / canvasHeight;
  let width = 0.76;
  let height = 0.76;

  if (aspect > canvasAspect) {
    height = width * canvasAspect / aspect;
  } else {
    width = height * aspect / canvasAspect;
  }

  return {
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
  };
}

function clampFrameRect(rect) {
  const width = clamp(rect.width, 0.12, 1);
  const height = clamp(rect.height, 0.12, 1);
  const x = clamp(rect.x, 0, 1 - width);
  const y = clamp(rect.y, 0, 1 - height);

  return { x, y, width, height };
}

function loadImageElement(url) {
  if (loadedImageCache.has(url)) {
    return loadedImageCache.get(url);
  }

  const imagePromise = new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });

  loadedImageCache.set(url, imagePromise);
  return imagePromise;
}

function releaseLoadedImage(url) {
  loadedImageCache.delete(url);
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getCanvasContext(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

function clearCanvas(canvas, background = '#f4f6f8', transparent = false) {
  const context = getCanvasContext(canvas);
  context.clearRect(0, 0, canvas.width, canvas.height);

  if (!transparent) {
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  return context;
}

function getSceneRect(imageWidth, imageHeight, canvasWidth, canvasHeight, sceneTransform) {
  const fitted = fitRect(imageWidth, imageHeight, canvasWidth, canvasHeight);
  const width = fitted.width * sceneTransform.scale;
  const height = fitted.height * sceneTransform.scale;
  const centerX = fitted.x + fitted.width / 2 + sceneTransform.x * canvasWidth;
  const centerY = fitted.y + fitted.height / 2 + sceneTransform.y * canvasHeight;

  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  };
}

function drawLoadedImageOnCanvas(image, canvas, sceneTransform) {
  const context = getCanvasContext(canvas);
  const rect = getSceneRect(image.naturalWidth, image.naturalHeight, canvas.width, canvas.height, sceneTransform);

  context.drawImage(image, rect.x, rect.y, rect.width, rect.height);

  return context;
}

async function renderPreviewFrame(items, canvas, sceneTransform, background = '#f4f6f8', transparent = false) {
  const context = clearCanvas(canvas, background, transparent);

  for (const item of items) {
    const image = await loadImageElement(item.url);
    drawLoadedImageOnCanvas(image, canvas, sceneTransform);
  }

  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function createDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);

  return { dosDate, dosTime };
}

function getCrc32(bytes) {
  let crc = 0xffffffff;

  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBlob(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const { dosDate, dosTime } = getDosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
    const crc32 = getCrc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, dosTime);
    writeUint16(localView, 12, dosDate);
    writeUint32(localView, 14, crc32);
    writeUint32(localView, 18, dataBytes.length);
    writeUint32(localView, 22, dataBytes.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, dosTime);
    writeUint16(centralView, 14, dosDate);
    writeUint32(centralView, 16, crc32);
    writeUint32(centralView, 20, dataBytes.length);
    writeUint32(centralView, 24, dataBytes.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, files.length);
  writeUint16(endView, 10, files.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, offset);
  writeUint16(endView, 20, 0);

  return new Blob([...localParts, ...centralParts, endRecord], { type: 'application/zip' });
}

function releaseFrame(frame) {
  frame.revoke?.();
  releaseLoadedImage(frame.previewUrl ?? frame.url);
  releaseLoadedImage(frame.sourceUrl ?? frame.url);
}

function releaseFrames(items) {
  items.forEach(releaseFrame);
}

async function createPreviewAssetUrl(sourceUrl) {
  const image = await loadImageElement(sourceUrl);
  const longEdge = Math.max(image.naturalWidth, image.naturalHeight);

  if (longEdge <= PREVIEW_SOURCE_MAX_LONG_EDGE) {
    return {
      previewUrl: sourceUrl,
      revokePreview: () => {},
    };
  }

  const scale = PREVIEW_SOURCE_MAX_LONG_EDGE / longEdge;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const context = getCanvasContext(canvas);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

  if (!blob) {
    return {
      previewUrl: sourceUrl,
      revokePreview: () => {},
    };
  }

  const previewObjectUrl = URL.createObjectURL(blob);

  return {
    previewUrl: previewObjectUrl,
    revokePreview: () => URL.revokeObjectURL(previewObjectUrl),
  };
}

async function normalizeFrameItem(item, index) {
  const revokeCallbacks = [];
  let sourceUrl = '';

  if ('path' in item && !('dataUrl' in item)) {
    sourceUrl = filePathToUrl(item.path);
  } else if ('dataUrl' in item) {
    sourceUrl = item.dataUrl;
  } else {
    sourceUrl = URL.createObjectURL(item);
    revokeCallbacks.push(() => URL.revokeObjectURL(sourceUrl));
  }

  const { previewUrl, revokePreview } = await createPreviewAssetUrl(sourceUrl);

  if (previewUrl !== sourceUrl) {
    revokeCallbacks.push(revokePreview);
  }

  return {
    id: `${item.name}-${item.path ?? item.lastModified ?? 'local'}-${index}-${Date.now()}`,
    name: item.name,
    size: item.size,
    type: item.type,
    url: previewUrl,
    previewUrl,
    sourceUrl,
    revoke: () => revokeCallbacks.forEach((callback) => callback()),
  };
}

function getGifPaletteSize(optimizePercent) {
  const ratio = 1 - optimizePercent / 100;
  return Math.max(16, Math.round(256 * ratio));
}

async function buildExportLayout(items, outputSizeMode, outputLongEdge) {
  const loadedFrames = await Promise.all(
    items.map(async (item) => ({
      item,
      image: await loadImageElement(item.sourceUrl ?? item.url),
    })),
  );
  const maxWidth = Math.max(...loadedFrames.map(({ image }) => image.naturalWidth));
  const maxHeight = Math.max(...loadedFrames.map(({ image }) => image.naturalHeight));
  const referenceLongEdge = Math.max(maxWidth, maxHeight);
  const scale = outputSizeMode === 'original' ? 1 : outputLongEdge / referenceLongEdge;
  const canvas = document.createElement('canvas');

  canvas.width = Math.max(1, Math.round(maxWidth * scale));
  canvas.height = Math.max(1, Math.round(maxHeight * scale));

  return {
    canvas,
    loadedFrames,
  };
}

function getOutputCanvas(sceneCanvas, outputFrame) {
  if (!outputFrame) {
    return sceneCanvas;
  }

  const croppedCanvas = document.createElement('canvas');
  const sourceX = Math.round(outputFrame.x * sceneCanvas.width);
  const sourceY = Math.round(outputFrame.y * sceneCanvas.height);
  const sourceWidth = Math.max(1, Math.round(outputFrame.width * sceneCanvas.width));
  const sourceHeight = Math.max(1, Math.round(outputFrame.height * sceneCanvas.height));

  croppedCanvas.width = sourceWidth;
  croppedCanvas.height = sourceHeight;

  const context = getCanvasContext(croppedCanvas);
  context.drawImage(
    sceneCanvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );

  return croppedCanvas;
}

let ffmpegSingleton = null;

async function loadFFmpeg() {
  if (!ffmpegSingleton) {
    ffmpegSingleton = new FFmpeg();
  }

  if (!ffmpegSingleton.loaded) {
    await ffmpegSingleton.load({ coreURL, wasmURL });
  }

  return ffmpegSingleton;
}

function App() {
  const fileInputRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const previewTimerRef = useRef(null);
  const previewFrameRef = useRef(null);
  const originalVideoRef = useRef(null);
  const framesRef = useRef([]);
  const videoSourceRef = useRef(null);
  const interactionRef = useRef(null);

  const [inputMode, setInputMode] = useState('images');
  const [videoSource, setVideoSource] = useState(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [trimStartTime, setTrimStartTime] = useState(0);
  const [trimEndTime, setTrimEndTime] = useState(0);
  const [isOriginalVideoPlaying, setIsOriginalVideoPlaying] = useState(false);
  const [frames, setFrames] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [delayMs, setDelayMs] = useState(120);
  const [delayInput, setDelayInput] = useState('120');
  const [frameStep, setFrameStep] = useState(1);
  const [frameStepInput, setFrameStepInput] = useState('1');
  const [movFps, setMovFps] = useState(12);
  const [movFpsInput, setMovFpsInput] = useState('12');
  const [outputSizeMode, setOutputSizeMode] = useState('long-edge');
  const [outputLongEdge, setOutputLongEdge] = useState(1280);
  const [gifOptimizePercent, setGifOptimizePercent] = useState(30);
  const [outputFormat, setOutputFormat] = useState('gif');
  const [isPlaying, setIsPlaying] = useState(true);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [statusText, setStatusText] = useState('Mode sec ve import et.');
  const [isExporting, setIsExporting] = useState(false);
  const [isZipExporting, setIsZipExporting] = useState(false);
  const [isImportingVideo, setIsImportingVideo] = useState(false);
  const [previewBackground, setPreviewBackground] = useState('#f4f6f8');
  const [transparentBackground, setTransparentBackground] = useState(false);
  const [stackFrames, setStackFrames] = useState(false);
  const [mirrorLoop, setMirrorLoop] = useState(false);
  const [sceneTransform, setSceneTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [transformMode, setTransformMode] = useState(false);
  const [showOutsideFrame, setShowOutsideFrame] = useState(false);
  const [isTransformDragging, setIsTransformDragging] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [framePreset, setFramePreset] = useState('none');
  const [outputFrame, setOutputFrame] = useState(null);
  const [draggedFrameId, setDraggedFrameId] = useState(null);
  const [dropTargetFrameId, setDropTargetFrameId] = useState(null);

  const trimmedFrames = useMemo(() => {
    if (inputMode !== 'video' || !frames.length) {
      return frames;
    }

    const frameDurationMs = Math.max(delayMs, MIN_DELAY);
    const startIndex = clamp(Math.floor((trimStartTime * 1000) / frameDurationMs), 0, Math.max(frames.length - 1, 0));
    const endIndex = clamp(Math.floor((trimEndTime * 1000) / frameDurationMs), startIndex, Math.max(frames.length - 1, 0));

    return frames.slice(startIndex, endIndex + 1);
  }, [delayMs, frames, inputMode, trimEndTime, trimStartTime]);

  const visibleFrames = useMemo(() => {
    return trimmedFrames.filter((_, index) => index % frameStep === 0);
  }, [trimmedFrames, frameStep]);

  const playbackFrames = useMemo(() => {
    if (inputMode !== 'images' || !mirrorLoop || visibleFrames.length < 3) {
      return visibleFrames;
    }

    return [...visibleFrames, ...visibleFrames.slice(1, -1).reverse()];
  }, [inputMode, mirrorLoop, visibleFrames]);

  const stackDisabled = useMemo(() => {
    return frames.some((frame) => frame.type === 'image/jpeg');
  }, [frames]);

  const isBusy = isExporting || isImportingVideo || isZipExporting;
  const importButtonLabel = inputMode === 'video' ? 'Load Video' : 'Start Import';
  const importAccept = inputMode === 'video' ? 'video/*,.mp4,.mov,.webm,.m4v' : 'image/*';
  const previewFps = Math.max(1, Math.round(1000 / delayMs));
  const exportDuration =
    outputFormat === 'mov'
      ? playbackFrames.length / Math.max(MIN_MOV_FPS, movFps)
      : (playbackFrames.length * delayMs) / 1000;

  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  useEffect(() => {
    setDelayInput(String(delayMs));
  }, [delayMs]);

  useEffect(() => {
    setFrameStepInput(String(frameStep));
  }, [frameStep]);

  useEffect(() => {
    setMovFpsInput(String(movFps));
  }, [movFps]);

  useEffect(() => {
    if (stackDisabled && stackFrames) {
      setStackFrames(false);
    }
  }, [stackDisabled, stackFrames]);

  useEffect(() => {
    if (!frames.length) {
      setSelectedId(null);
      setPreviewIndex(0);
      return;
    }

    if (!selectedId) {
      setSelectedId(frames[0].id);
    }
  }, [frames, selectedId]);

  useEffect(() => {
    if (draggedFrameId && !frames.some((frame) => frame.id === draggedFrameId)) {
      setDraggedFrameId(null);
    }

    if (dropTargetFrameId && !frames.some((frame) => frame.id === dropTargetFrameId)) {
      setDropTargetFrameId(null);
    }
  }, [draggedFrameId, dropTargetFrameId, frames]);

  useEffect(() => {
    if (inputMode !== 'video') {
      setTrimStartTime(0);
      setTrimEndTime(0);
      setIsOriginalVideoPlaying(false);
      return;
    }

    if (videoDuration > 0) {
      setTrimStartTime((current) => clamp(current, 0, Math.max(videoDuration - 0.01, 0)));
      setTrimEndTime((current) => {
        if (current <= 0) {
          return videoDuration;
        }

        return clamp(current, 0.01, videoDuration);
      });
    }
  }, [inputMode, videoDuration]);

  useEffect(() => {
    return () => {
      releaseFrames(framesRef.current);
      videoSourceRef.current?.revoke?.();
    };
  }, []);

  useEffect(() => {
    if (inputMode === 'video' && visibleFrames.length) {
      const relativeTime = clamp(videoCurrentTime - trimStartTime, 0, Math.max(trimEndTime - trimStartTime, 0));
      const baseIndex = Math.floor((relativeTime * 1000) / Math.max(delayMs, MIN_DELAY));
      setPreviewIndex(clamp(Math.floor(baseIndex / frameStep), 0, Math.max(visibleFrames.length - 1, 0)));
    }
  }, [delayMs, frameStep, inputMode, trimEndTime, trimStartTime, videoCurrentTime, visibleFrames.length]);

  useEffect(() => {
    if (!playbackFrames.length) {
      const canvas = previewCanvasRef.current;

      if (canvas) {
        clearCanvas(canvas, previewBackground, transparentBackground);
      }

      return undefined;
    }

    const canvas = previewCanvasRef.current;
    let cancelled = false;

    const renderPreview = async (currentIndex) => {
      if (!canvas || playbackFrames.length === 0) {
        return;
      }

      const normalizedIndex = clamp(currentIndex, 0, playbackFrames.length - 1);
      const itemsToDraw = stackFrames ? playbackFrames.slice(0, normalizedIndex + 1) : [playbackFrames[normalizedIndex]];

      await renderPreviewFrame(itemsToDraw, canvas, sceneTransform, previewBackground, transparentBackground);

      if (!cancelled) {
        setSelectedId(playbackFrames[normalizedIndex].id);
      }
    };

    renderPreview(previewIndex);

    if (previewTimerRef.current) {
      window.clearInterval(previewTimerRef.current);
    }

    if (isPlaying && playbackFrames.length > 1 && (inputMode === 'images' || (inputMode === 'video' && !isOriginalVideoPlaying))) {
      previewTimerRef.current = window.setInterval(() => {
        setPreviewIndex((current) => (current + 1) % playbackFrames.length);
      }, delayMs);
    }

    return () => {
      cancelled = true;

      if (previewTimerRef.current) {
        window.clearInterval(previewTimerRef.current);
        previewTimerRef.current = null;
      }
    };
  }, [
    delayMs,
    inputMode,
    isPlaying,
    previewBackground,
    previewIndex,
    sceneTransform,
    stackFrames,
    transparentBackground,
    playbackFrames,
    isOriginalVideoPlaying,
  ]);

  useEffect(() => {
    const handlePointerMove = (event) => {
      const activeInteraction = interactionRef.current;
      const frameElement = previewFrameRef.current;

      if (!activeInteraction || !frameElement) {
        return;
      }

      const rect = frameElement.getBoundingClientRect();
      const deltaX = (event.clientX - activeInteraction.startClientX) / rect.width;
      const deltaY = (event.clientY - activeInteraction.startClientY) / rect.height;

      if (activeInteraction.type === 'transform') {
        setSceneTransform((current) => ({
          ...current,
          x: clamp(activeInteraction.startValue.x + deltaX, -1.2, 1.2),
          y: clamp(activeInteraction.startValue.y + deltaY, -1.2, 1.2),
        }));
        return;
      }

      if (!outputFrame) {
        return;
      }

      if (activeInteraction.type === 'frame-move') {
        setOutputFrame(
          clampFrameRect({
            ...activeInteraction.startValue,
            x: activeInteraction.startValue.x + deltaX,
            y: activeInteraction.startValue.y + deltaY,
          }),
        );
        return;
      }

      if (activeInteraction.type === 'frame-resize') {
        const aspect = getFrameAspect(framePreset);
        let nextWidth = clamp(activeInteraction.startValue.width + deltaX, 0.12, 1);
        let nextHeight = clamp(activeInteraction.startValue.height + deltaY, 0.12, 1);

        if (aspect) {
          const canvasAspect = PREVIEW_CANVAS_WIDTH / PREVIEW_CANVAS_HEIGHT;
          nextHeight = clamp(nextWidth * canvasAspect / aspect, 0.12, 1);

          if (activeInteraction.startValue.y + nextHeight > 1) {
            nextHeight = 1 - activeInteraction.startValue.y;
            nextWidth = clamp(nextHeight * aspect / canvasAspect, 0.12, 1);
          }
        }

        setOutputFrame(
          clampFrameRect({
            ...activeInteraction.startValue,
            width: nextWidth,
            height: nextHeight,
          }),
        );
      }
    };

    const handlePointerUp = () => {
      if (interactionRef.current?.type === 'transform') {
        setIsTransformDragging(false);
      }

      interactionRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [framePreset, outputFrame]);

  const releaseVideoSource = () => {
    videoSourceRef.current?.revoke?.();
    videoSourceRef.current = null;
    setVideoSource(null);
    setVideoDuration(0);
    setVideoCurrentTime(0);
    setTrimStartTime(0);
    setTrimEndTime(0);
    setIsOriginalVideoPlaying(false);
  };

  const setNextVideoSource = (item) => {
    releaseVideoSource();

    if (!item) {
      return;
    }

    if ('dataUrl' in item) {
      const sourceUrl = item.path ? filePathToUrl(item.path) : item.dataUrl;
      const nextSource = {
        name: item.name,
        type: item.type,
        url: sourceUrl,
        revoke: () => {},
      };

      videoSourceRef.current = nextSource;
      setVideoSource(nextSource);
      return;
    }

    const objectUrl = URL.createObjectURL(item);
    const nextSource = {
      name: item.name,
      type: item.type,
      url: objectUrl,
      revoke: () => URL.revokeObjectURL(objectUrl),
    };

    videoSourceRef.current = nextSource;
    setVideoSource(nextSource);
  };

  const resetViewport = () => {
    setSceneTransform({ x: 0, y: 0, scale: 1 });
    setTransformMode(false);
    setShowOutsideFrame(false);
    setIsTransformDragging(false);
    setCropMode(false);
    setFramePreset('none');
    setOutputFrame(null);
  };

  const resetFrameList = (nextStatus = 'Liste temizlendi.') => {
    releaseFrames(framesRef.current);
    setFrames([]);
    setSelectedId(null);
    setPreviewIndex(0);
    setIsPlaying(true);
    setStatusText(nextStatus);
    resetViewport();
    releaseVideoSource();
  };

  const replaceFrames = (items, nextStatus) => {
    return Promise.all(items.map(normalizeFrameItem)).then((nextFrames) => {
      releaseFrames(framesRef.current);

      setFrames(nextFrames);
      setSelectedId(nextFrames[0]?.id ?? null);
      setPreviewIndex(0);
      setIsPlaying(true);
      setStatusText(nextStatus ?? `${nextFrames.length} kare eklendi.`);
      resetViewport();
    });
  };

  const appendFrames = (items, nextStatus) => {
    return Promise.all(items.map(normalizeFrameItem)).then((nextFrames) => {
      setFrames((current) => [...current, ...nextFrames]);
      setSelectedId((currentSelectedId) => currentSelectedId ?? nextFrames[0]?.id ?? null);
      setPreviewIndex(0);
      setIsPlaying(true);
      setStatusText(nextStatus ?? `${nextFrames.length} kare eklendi.`);
    });
  };

  const handleImageSelection = async (items) => {
    const filteredItems = items
      .filter((item) => ACCEPTED_IMAGE_TYPES.includes(item.type) || item.type.startsWith('image/'))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

    if (!filteredItems.length) {
      setStatusText('Desteklenen bir gorsel secilmedi.');
      return;
    }

    releaseVideoSource();
    setStatusText('Gorseller preview icin optimize ediliyor...');
    await appendFrames(filteredItems);
  };

  const extractVideoFrames = async (videoItem) => {
    const ffmpeg = await loadFFmpeg();
    const sampleFps = (1000 / Math.max(delayMs, MIN_DELAY)).toFixed(4);
    const baseName = videoItem.name.replace(/\.[^/.]+$/, '') || 'video';
    const inputExtension = getFileExtension(videoItem.name) || '.mp4';
    const inputFileName = `source-${Date.now()}${inputExtension}`;
    const frameDir = `frames-${Date.now()}`;
    const videoSourceValue = 'dataUrl' in videoItem ? videoItem.dataUrl : videoItem;

    await ffmpeg.createDir(frameDir);
    await ffmpeg.writeFile(inputFileName, await fetchFile(videoSourceValue));
    await ffmpeg.exec(['-i', inputFileName, '-vf', `fps=${sampleFps}`, `${frameDir}/frame-%04d.png`]);

    const directoryEntries = await ffmpeg.listDir(frameDir);
    const frameEntries = directoryEntries
      .filter((entry) => !entry.isDir && entry.name.endsWith('.png'))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

    if (!frameEntries.length) {
      throw new Error('Videodan kare cikartilamadi.');
    }

    const extractedFrames = [];

    for (let index = 0; index < frameEntries.length; index += 1) {
      const entry = frameEntries[index];
      const bytes = await ffmpeg.readFile(`${frameDir}/${entry.name}`);
      const blob = new Blob([bytes], { type: 'image/png' });
      const dataUrl = await readBlobAsDataUrl(blob);

      extractedFrames.push({
        dataUrl,
        name: `${baseName}-${String(index + 1).padStart(4, '0')}.png`,
        path: `${frameDir}/${entry.name}`,
        size: bytes.byteLength,
        type: 'image/png',
      });
    }

    for (const entry of frameEntries) {
      await ffmpeg.deleteFile(`${frameDir}/${entry.name}`);
    }

    await ffmpeg.deleteFile(inputFileName);
    await ffmpeg.deleteDir(frameDir);

    return extractedFrames;
  };

  const handleVideoSelection = async (items) => {
    const [videoItem] = items.filter(
      (item) => ACCEPTED_VIDEO_TYPES.includes(item.type) || item.type.startsWith('video/'),
    );

    if (!videoItem) {
      setStatusText('Desteklenen bir video secilmedi.');
      return;
    }

    setIsImportingVideo(true);
    setStatusText('Video kareleri hazirlaniyor...');
    setNextVideoSource(videoItem);

    try {
      const extractedFrames = await extractVideoFrames(videoItem);
      await replaceFrames(extractedFrames, `${extractedFrames.length} kare videodan cikartildi.`);
    } catch (error) {
      setStatusText(`Video import hatasi: ${error.message}`);
      console.error(error);
    } finally {
      setIsImportingVideo(false);
    }
  };

  const handleImport = async (event) => {
    const pickedFiles = Array.from(event.target.files ?? []);

    if (inputMode === 'video') {
      await handleVideoSelection(pickedFiles);
    } else {
      await handleImageSelection(pickedFiles);
    }

    event.target.value = '';
  };

  const handleImportClick = async () => {
    if (!desktopApi) {
      fileInputRef.current?.click();
      return;
    }

    const pickedFiles = await desktopApi.openMedia(inputMode);

    if (!pickedFiles.length) {
      return;
    }

    if (inputMode === 'video') {
      await handleVideoSelection(pickedFiles);
    } else {
      await handleImageSelection(pickedFiles);
    }
  };

  const handleModeChange = (nextMode) => {
    if (nextMode === inputMode) {
      return;
    }

    setInputMode(nextMode);
    resetFrameList(nextMode === 'video' ? 'Video modu secildi.' : 'Images modu secildi.');
  };

  const commitDelayInput = () => {
    const nextDelay = clampNumber(delayInput, delayMs, MIN_DELAY, MAX_DELAY);
    setDelayMs(nextDelay);
    setDelayInput(String(nextDelay));
  };

  const commitFrameStepInput = () => {
    const nextStep = clampNumber(frameStepInput, frameStep, MIN_STEP);
    setFrameStep(nextStep);
    setFrameStepInput(String(nextStep));
  };

  const commitMovFpsInput = () => {
    const nextMovFps = clampNumber(movFpsInput, movFps, MIN_MOV_FPS);
    setMovFps(nextMovFps);
    setMovFpsInput(String(nextMovFps));
  };

  const syncPreviewToTime = (timeInSeconds) => {
    if (!visibleFrames.length) {
      return;
    }

    const relativeTime =
      inputMode === 'video'
        ? clamp(timeInSeconds - trimStartTime, 0, Math.max(trimEndTime - trimStartTime, 0))
        : timeInSeconds;
    const baseIndex = Math.floor((relativeTime * 1000) / Math.max(delayMs, MIN_DELAY));
    const visibleIndex = clamp(Math.floor(baseIndex / frameStep), 0, visibleFrames.length - 1);

    setPreviewIndex(visibleIndex);
  };

  const pauseVideoPlayback = () => {
    const video = originalVideoRef.current;

    if (video && !video.paused) {
      video.pause();
    }
  };

  const handlePreviewHover = (frameId, index) => {
    setSelectedId(frameId);
    setPreviewIndex(index);
    setIsPlaying(false);

    if (inputMode === 'video') {
      pauseVideoPlayback();
      const nextTime = (index * frameStep * delayMs) / 1000;

      if (originalVideoRef.current) {
        originalVideoRef.current.currentTime = clamp(nextTime, 0, videoDuration || nextTime);
      }

      setVideoCurrentTime(nextTime);
    }
  };

  const clearThumbDragState = () => {
    setDraggedFrameId(null);
    setDropTargetFrameId(null);
  };

  const reorderVisibleFrames = (sourceId, targetId) => {
    if (!sourceId || !targetId || sourceId === targetId) {
      clearThumbDragState();
      return;
    }

    setFrames((current) => {
      const nextFrames = moveFrameByIds(current, sourceId, targetId);

      if (nextFrames === current) {
        return current;
      }

      const focusId = selectedId && nextFrames.some((frame) => frame.id === selectedId) ? selectedId : sourceId;
      const nextVisibleFrames = nextFrames.filter((_, index) => index % frameStep === 0);
      const nextVisibleIndex = nextVisibleFrames.findIndex((frame) => frame.id === focusId);

      setSelectedId(focusId);

      if (nextVisibleIndex >= 0) {
        setPreviewIndex(nextVisibleIndex);
      }

      setStatusText('Kare sirasi guncellendi.');
      return nextFrames;
    });

    clearThumbDragState();
  };

  const handleThumbDragStart = (frameId, event) => {
    if (visibleFrames.length < 2) {
      return;
    }

    setDraggedFrameId(frameId);
    setDropTargetFrameId(frameId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', frameId);
  };

  const handleThumbDragOver = (frameId, event) => {
    if (!draggedFrameId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    if (frameId !== draggedFrameId && dropTargetFrameId !== frameId) {
      setDropTargetFrameId(frameId);
    }
  };

  const handleThumbDrop = (targetId, event) => {
    event.preventDefault();
    const sourceId = draggedFrameId || event.dataTransfer.getData('text/plain');
    reorderVisibleFrames(sourceId, targetId);
  };

  const handleVideoPlay = async () => {
    const video = originalVideoRef.current;

    if (!video) {
      return;
    }

    if (video.currentTime < trimStartTime || video.currentTime >= trimEndTime) {
      video.currentTime = trimStartTime;
    }

    setIsOriginalVideoPlaying(true);
    setIsPlaying(false);
    await video.play();
  };

  const handleVideoPause = () => {
    pauseVideoPlayback();
    setIsOriginalVideoPlaying(false);
    setIsPlaying(true);
    syncPreviewToTime(videoCurrentTime);
  };

  const handleContinuePreview = async () => {
    if (!visibleFrames.length) {
      return;
    }

    if (inputMode === 'video') {
      await handleVideoPlay();
      return;
    }

    setIsPlaying(true);
  };

  const handlePreviewToggle = async () => {
    if (isPlaying) {
      setIsPlaying(false);

      if (inputMode === 'video') {
        pauseVideoPlayback();
      }

      return;
    }

    await handleContinuePreview();
  };

  const handleVideoSeek = (nextTime) => {
    const clampedTime = clamp(nextTime, trimStartTime, trimEndTime || nextTime);
    const video = originalVideoRef.current;

    if (video) {
      video.currentTime = clampedTime;
    }

    setVideoCurrentTime(clampedTime);

    if (!isOriginalVideoPlaying) {
      syncPreviewToTime(clampedTime);
    }
  };

  const handleRemoveFrame = (frameId) => {
    setFrames((current) => {
      const nextFrames = current.filter((frame) => frame.id !== frameId);
      const removedFrame = current.find((frame) => frame.id === frameId);

      if (removedFrame) {
        releaseFrame(removedFrame);
      }

      setSelectedId((currentSelectedId) => {
        if (currentSelectedId !== frameId) {
          return currentSelectedId;
        }

        return nextFrames[0]?.id ?? null;
      });

      setPreviewIndex(0);
      setStatusText('Kare kaldirildi.');

      return nextFrames;
    });
  };

  const saveExportBlob = async (blob, extension) => {
    const suggestedName = `giffer-${Date.now()}.${extension}`;

    if (!desktopApi) {
      createDownload(blob, suggestedName);
      return { canceled: false };
    }

    const buffer = await blob.arrayBuffer();

    return desktopApi.saveExport({
      defaultExtension: extension,
      fileBytes: Array.from(new Uint8Array(buffer)),
      suggestedName,
    });
  };

  const exportGif = async (items) => {
    const { canvas, loadedFrames } = await buildExportLayout(items, outputSizeMode, outputLongEdge);
    const encoder = GIFEncoder();
    const paletteSize = getGifPaletteSize(gifOptimizePercent);

    for (let index = 0; index < loadedFrames.length; index += 1) {
      if (!stackFrames || index === 0) {
        clearCanvas(canvas, previewBackground, transparentBackground);
      }

      drawLoadedImageOnCanvas(loadedFrames[index].image, canvas, sceneTransform);

      const outputCanvas = getOutputCanvas(canvas, outputFrame);
      const context = getCanvasContext(outputCanvas);
      const imageData = context.getImageData(0, 0, outputCanvas.width, outputCanvas.height);
      const quantizeFormat = transparentBackground ? 'rgba4444' : 'rgb565';
      const palette = quantize(
        imageData.data,
        paletteSize,
        transparentBackground ? { format: quantizeFormat, oneBitAlpha: true } : undefined,
      );
      const indexedPixels = applyPalette(imageData.data, palette, quantizeFormat);
      const transparentIndex = transparentBackground ? palette.findIndex((color) => color[3] === 0) : -1;

      encoder.writeFrame(indexedPixels, outputCanvas.width, outputCanvas.height, {
        palette,
        delay: delayMs,
        transparent: transparentIndex >= 0,
        transparentIndex,
      });
    }

    encoder.finish();

    const gifBytes = encoder.bytesView();
    const blob = new Blob([gifBytes], { type: 'image/gif' });

    return saveExportBlob(blob, 'gif');
  };

  const exportMov = async (items) => {
    const ffmpeg = await loadFFmpeg();
    const fps = Math.max(MIN_MOV_FPS, movFps);
    const { canvas, loadedFrames } = await buildExportLayout(items, outputSizeMode, outputLongEdge);

    for (let index = 0; index < loadedFrames.length; index += 1) {
      if (!stackFrames || index === 0) {
        clearCanvas(canvas, previewBackground, transparentBackground);
      }

      drawLoadedImageOnCanvas(loadedFrames[index].image, canvas, sceneTransform);

      const outputCanvas = getOutputCanvas(canvas, outputFrame);
      const blob = await new Promise((resolve) => outputCanvas.toBlob(resolve, 'image/png'));

      if (!blob) {
        throw new Error('PNG kare olusturulamadi.');
      }

      const filename = `frame-${String(index).padStart(4, '0')}.png`;
      await ffmpeg.writeFile(filename, await fetchFile(blob));
    }

    await ffmpeg.exec([
      '-framerate',
      String(fps),
      '-i',
      'frame-%04d.png',
      '-c:v',
      'png',
      '-pix_fmt',
      'rgba',
      'output.mov',
    ]);

    const output = await ffmpeg.readFile('output.mov');
    const blob = new Blob([output.buffer], { type: 'video/quicktime' });
    const result = await saveExportBlob(blob, 'mov');

    for (let index = 0; index < loadedFrames.length; index += 1) {
      await ffmpeg.deleteFile(`frame-${String(index).padStart(4, '0')}.png`);
    }

    await ffmpeg.deleteFile('output.mov');

    return result;
  };

  const handleExport = async () => {
    if (!visibleFrames.length || isBusy) {
      return;
    }

    setIsExporting(true);
    setStatusText(`${outputFormat.toUpperCase()} hazirlaniyor...`);

    try {
      const result = outputFormat === 'gif' ? await exportGif(playbackFrames) : await exportMov(playbackFrames);

      if (result?.canceled) {
        setStatusText('Kaydetme iptal edildi.');
      } else if (result?.filePath) {
        setStatusText(`${outputFormat.toUpperCase()} kaydedildi: ${result.filePath}`);
      } else {
        setStatusText(`${outputFormat.toUpperCase()} disa aktarildi.`);
      }
    } catch (error) {
      setStatusText(`Export hatasi: ${error.message}`);
      console.error(error);
    } finally {
      setIsExporting(false);
    }
  };

  const handleZipExport = async () => {
    if (inputMode !== 'video' || !visibleFrames.length || isBusy) {
      return;
    }

    setIsZipExporting(true);
    setStatusText('ZIP hazirlaniyor...');

    try {
      const zipFiles = await Promise.all(
        visibleFrames.map(async (frame, index) => {
          const response = await fetch(frame.sourceUrl ?? frame.url);
          const buffer = await response.arrayBuffer();
          const extension = getFileExtension(frame.name) || '.png';

          return {
            name: `frame-${String(index + 1).padStart(4, '0')}${extension}`,
            bytes: new Uint8Array(buffer),
          };
        }),
      );
      const zipBlob = buildZipBlob(zipFiles);
      const result = await saveExportBlob(zipBlob, 'zip');

      if (result?.canceled) {
        setStatusText('ZIP kaydetme iptal edildi.');
      } else if (result?.filePath) {
        setStatusText(`ZIP kaydedildi: ${result.filePath}`);
      } else {
        setStatusText('ZIP disa aktarildi.');
      }
    } catch (error) {
      setStatusText(`ZIP export hatasi: ${error.message}`);
      console.error(error);
    } finally {
      setIsZipExporting(false);
    }
  };

  const applyFramePreset = (preset) => {
    if (preset === 'none') {
      setFramePreset('none');
      setOutputFrame(null);
      return;
    }

    setFramePreset(preset);
    setOutputFrame(createCenteredFrame(preset, PREVIEW_CANVAS_WIDTH, PREVIEW_CANVAS_HEIGHT));
  };

  const handleCropToggle = () => {
    setCropMode((current) => !current);

    if (!outputFrame) {
      setFramePreset('16:9');
      setOutputFrame(createCenteredFrame('16:9', PREVIEW_CANVAS_WIDTH, PREVIEW_CANVAS_HEIGHT));
    }
  };

  const startInteraction = (type, startValue, event) => {
    event.preventDefault();
    event.stopPropagation();

    if (type === 'transform') {
      setIsTransformDragging(true);
    }

    interactionRef.current = {
      type,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startValue,
    };
  };

  const handlePreviewPointerDown = (event) => {
    if (!transformMode || !previewFrameRef.current) {
      return;
    }

    if (outputFrame) {
      const rect = previewFrameRef.current.getBoundingClientRect();
      const relativeX = (event.clientX - rect.left) / rect.width;
      const relativeY = (event.clientY - rect.top) / rect.height;
      const insideFrame =
        relativeX >= outputFrame.x &&
        relativeX <= outputFrame.x + outputFrame.width &&
        relativeY >= outputFrame.y &&
        relativeY <= outputFrame.y + outputFrame.height;

      if (!insideFrame) {
        return;
      }
    }

    startInteraction('transform', sceneTransform, event);
  };

  const handlePreviewWheel = (event) => {
    if (!transformMode) {
      return;
    }

    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.08 : 0.08;

    setSceneTransform((current) => ({
      ...current,
      scale: clamp(Number((current.scale + delta).toFixed(2)), MIN_SCALE, MAX_SCALE),
    }));
  };

  const frameBoxStyle = outputFrame
    ? {
        left: `${outputFrame.x * 100}%`,
        top: `${outputFrame.y * 100}%`,
        width: `${outputFrame.width * 100}%`,
        height: `${outputFrame.height * 100}%`,
      }
    : null;
  const outsideFrameVisible = !outputFrame || showOutsideFrame || isTransformDragging;
  const safeVideoDuration = Math.max(videoDuration, 0.01);
  const trimStartPercent = (trimStartTime / safeVideoDuration) * 100;
  const trimEndPercent = ((trimEndTime || safeVideoDuration) / safeVideoDuration) * 100;
  const trimSelectionStyle = {
    left: `${trimStartPercent}%`,
    width: `${Math.max(trimEndPercent - trimStartPercent, 0)}%`,
  };

  return (
    <div className="app-shell">
      <aside className="left-panel">
        <div className="panel-block">
          <div className="mode-switch">
            <button
              className={`mode-button ${inputMode === 'images' ? 'is-active' : ''}`}
              disabled={isBusy}
              onClick={() => handleModeChange('images')}
            >
              Images to GIF
            </button>
            <button
              className={`mode-button ${inputMode === 'video' ? 'is-active' : ''}`}
              disabled={isBusy}
              onClick={() => handleModeChange('video')}
            >
              Video to GIF
            </button>
          </div>
        </div>

        <div className="panel-block">
          <button className="primary-button" onClick={handleImportClick} disabled={isBusy}>
            {isImportingVideo ? 'Processing Video...' : importButtonLabel}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={importAccept}
            multiple={inputMode === 'images'}
            hidden
            onChange={handleImport}
          />
          <p className="status-line">{statusText}</p>
        </div>

        <div className="panel-block">
          <label className="field-label">Delay (ms)</label>
          <input
            className="text-field"
            type="number"
            min={MIN_DELAY}
            max={MAX_DELAY}
            value={delayInput}
            onChange={(event) => setDelayInput(event.target.value)}
            onBlur={commitDelayInput}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitDelayInput();
              }
            }}
          />
          <input
            className="timeline-slider"
            type="range"
            min={MIN_DELAY}
            max={MAX_DELAY}
            step="1"
            value={delayMs}
            onChange={(event) => {
              const nextDelay = clampNumber(event.target.value, delayMs, MIN_DELAY, MAX_DELAY);
              setDelayMs(nextDelay);
              setDelayInput(String(nextDelay));
            }}
          />

          <label className="field-label">Atlama degeri</label>
          <input
            className="text-field"
            type="number"
            min={MIN_STEP}
            value={frameStepInput}
            onChange={(event) => setFrameStepInput(event.target.value)}
            onBlur={commitFrameStepInput}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitFrameStepInput();
              }
            }}
          />

          <label className={`check-row ${stackDisabled ? 'is-disabled' : ''}`}>
            <input
              type="checkbox"
              checked={stackFrames}
              disabled={stackDisabled}
              onChange={(event) => setStackFrames(event.target.checked)}
            />
            <span>Ustuste ekle?</span>
          </label>

          <p className={`hint-text ${stackDisabled ? 'is-disabled' : ''}`}>
            {stackDisabled
              ? 'JPG/JPEG varken stack kapali kalir.'
              : "PNG'leri ust uste cizer, arkadaki kareyi kaybetmez."}
          </p>

          {inputMode === 'images' ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={mirrorLoop}
                onChange={(event) => setMirrorLoop(event.target.checked)}
              />
              <span>Mirror Loop</span>
            </label>
          ) : null}

          <div className="double-actions">
            <button className="primary-button" onClick={handlePreviewToggle} disabled={isBusy}>
              {isPlaying ? 'Pause Preview' : 'Continue Preview'}
            </button>
            <button className="ghost-button" onClick={() => resetFrameList()} disabled={isBusy}>
              Clear List
            </button>
          </div>
        </div>

        <div className="panel-block">
          <label className="field-label">Kayit bicimi</label>
          <select
            className="select-field"
            value={outputFormat}
            onChange={(event) => setOutputFormat(event.target.value)}
          >
            <option value="gif">GIF</option>
            <option value="mov">MOV</option>
          </select>

          <label className="field-label">Cikti boyutu</label>
          <select
            className="select-field"
            value={outputSizeMode}
            onChange={(event) => setOutputSizeMode(event.target.value)}
          >
            <option value="long-edge">Uzun kenar</option>
            <option value="original">Orjinal boyut</option>
          </select>

          <label className="field-label">GIF optimize (%)</label>
          <input
            className="text-field"
            type="number"
            min={MIN_OPTIMIZE}
            max={MAX_OPTIMIZE}
            value={gifOptimizePercent}
            onChange={(event) =>
              setGifOptimizePercent(clampNumber(event.target.value, 30, MIN_OPTIMIZE, MAX_OPTIMIZE))
            }
          />

          {outputSizeMode === 'long-edge' ? (
            <>
              <label className="field-label">Cikti uzun kenar (px)</label>
              <input
                className="text-field"
                type="number"
                min={MIN_LONG_EDGE}
                value={outputLongEdge}
                onChange={(event) => setOutputLongEdge(clampNumber(event.target.value, 1280, MIN_LONG_EDGE))}
              />
            </>
          ) : null}

          <label className="field-label">MOV FPS</label>
          <input
            className="text-field"
            type="number"
            min={MIN_MOV_FPS}
            value={movFpsInput}
            onChange={(event) => setMovFpsInput(event.target.value)}
            onBlur={commitMovFpsInput}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitMovFpsInput();
              }
            }}
          />

          <label className="field-label">Preview arka plani</label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={transparentBackground}
              onChange={(event) => setTransparentBackground(event.target.checked)}
            />
            <span>Transparan</span>
          </label>
          <input
            className="color-field"
            type="color"
            value={previewBackground}
            disabled={transparentBackground}
            onChange={(event) => setPreviewBackground(event.target.value)}
          />
        </div>

        <div className="panel-block stats-block">
          <div className="stat-row">
            <span>Toplam kare</span>
            <strong>{frames.length}</strong>
          </div>
          <div className="stat-row">
            <span>Kullanilan kare</span>
            <strong>{playbackFrames.length}</strong>
          </div>
          <div className="stat-row">
            <span>Preview FPS</span>
            <strong>{previewFps}</strong>
          </div>
          <div className="stat-row">
            <span>MOV FPS</span>
            <strong>{movFps}</strong>
          </div>
          <div className="stat-row">
            <span>Sure</span>
            <strong>{exportDuration.toFixed(2)}s</strong>
          </div>
        </div>

        <div className="panel-block">
          <button className="primary-button" disabled={!visibleFrames.length || isBusy} onClick={handleExport}>
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </aside>

      <main className="workspace">
        <div className="topbar">
          <div className="topbar-status">{playbackFrames.length} active frames</div>
          <div className="topbar-metric">
            <span>Delay</span>
            <strong>{delayMs} ms</strong>
          </div>
          <div className="topbar-metric">
            <span>Step</span>
            <strong>{frameStep}</strong>
          </div>
          <div className={`topbar-metric ${stackDisabled ? 'is-disabled' : ''}`}>
            <span>Stack</span>
            <strong>{stackFrames ? 'On' : 'Off'}</strong>
          </div>
        </div>

        <section className={`preview-panel preview-panel-full ${inputMode === 'video' ? 'is-split' : 'is-single'}`}>
          {inputMode === 'video' ? (
            <div className="preview-pane">
              <div className="pane-title">Original</div>
              <div className="video-stage">
                {videoSource ? (
                  <video
                    ref={originalVideoRef}
                    className="original-video"
                    src={videoSource.url}
                    onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
                    onTimeUpdate={(event) => {
                      const currentTime = event.currentTarget.currentTime;
                      const nextTrimEnd = trimEndTime || event.currentTarget.duration || 0;

                      if (nextTrimEnd > 0 && currentTime >= nextTrimEnd) {
                        event.currentTarget.pause();
                        event.currentTarget.currentTime = nextTrimEnd;
                        setVideoCurrentTime(nextTrimEnd);
                        setIsOriginalVideoPlaying(false);
                        setIsPlaying(true);
                        syncPreviewToTime(nextTrimEnd);
                        return;
                      }

                      setVideoCurrentTime(currentTime);
                    }}
                    onPlay={() => {
                      setIsOriginalVideoPlaying(true);
                      setIsPlaying(false);
                    }}
                    onPause={() => {
                      setIsOriginalVideoPlaying(false);
                      setIsPlaying(true);
                      syncPreviewToTime(originalVideoRef.current?.currentTime ?? 0);
                    }}
                    onEnded={() => {
                      setIsOriginalVideoPlaying(false);
                      setIsPlaying(true);
                    }}
                    playsInline
                    muted
                  />
                ) : (
                  <div className="video-empty">Video yuklenince burada gorunecek.</div>
                )}
              </div>
              <div className="video-controls">
                <button className="ghost-button" onClick={handleVideoPlay} disabled={!videoSource || isBusy}>
                  Play
                </button>
                <button className="ghost-button" onClick={handleVideoPause} disabled={!videoSource || isBusy}>
                  Pause
                </button>
                <div className="timeline-stack">
                  <div className="trim-selection" style={trimSelectionStyle} />
                  <input
                    className="timeline-slider timeline-slider-seek"
                    type="range"
                    min="0"
                    max={videoDuration || 0}
                    step="0.01"
                    value={Math.min(videoCurrentTime, videoDuration || 0)}
                    disabled={!videoSource}
                    onChange={(event) => handleVideoSeek(Number(event.target.value))}
                  />
                  <input
                    className="timeline-slider timeline-slider-handle timeline-slider-start"
                    type="range"
                    min="0"
                    max={videoDuration || 0}
                    step="0.01"
                    value={Math.min(trimStartTime, Math.max((trimEndTime || videoDuration) - 0.01, 0))}
                    disabled={!videoSource}
                    onChange={(event) => {
                      const nextStart = Math.min(Number(event.target.value), Math.max((trimEndTime || videoDuration) - 0.01, 0));
                      setTrimStartTime(nextStart);

                      if (videoCurrentTime < nextStart) {
                        handleVideoSeek(nextStart);
                      } else {
                        syncPreviewToTime(videoCurrentTime);
                      }
                    }}
                  />
                  <input
                    className="timeline-slider timeline-slider-handle timeline-slider-end"
                    type="range"
                    min="0"
                    max={videoDuration || 0}
                    step="0.01"
                    value={trimEndTime || videoDuration || 0}
                    disabled={!videoSource}
                    onChange={(event) => {
                      const nextEnd = Math.max(Number(event.target.value), Math.min(trimStartTime + 0.01, videoDuration || 0));
                      setTrimEndTime(nextEnd);

                      if (videoCurrentTime > nextEnd) {
                        handleVideoSeek(nextEnd);
                      } else {
                        syncPreviewToTime(videoCurrentTime);
                      }
                    }}
                  />
                </div>
                <span className="time-readout">
                  {formatTime(videoCurrentTime)} / {formatTime(videoDuration)}
                </span>
              </div>
            </div>
          ) : null}

          <div className="preview-pane gif-pane">
            <div className="pane-title">GIF Preview</div>

            <div
              className={`preview-stage ${!isPlaying ? 'is-paused' : ''} ${transformMode ? 'is-transforming' : ''} ${isOriginalVideoPlaying ? 'is-suspended' : ''}`}
              style={{
                '--preview-stage-color': transparentBackground ? '#eef2f6' : previewBackground,
                '--preview-canvas-color': transparentBackground ? 'transparent' : previewBackground,
              }}
              onClick={handleContinuePreview}
              onPointerDown={handlePreviewPointerDown}
              onWheel={handlePreviewWheel}
            >
              <div ref={previewFrameRef} className="preview-frame">
                <canvas
                  ref={previewCanvasRef}
                  width={PREVIEW_CANVAS_WIDTH}
                  height={PREVIEW_CANVAS_HEIGHT}
                />

                {outputFrame ? (
                  <div
                    className={`frame-mask ${cropMode ? 'is-editing' : ''} ${outsideFrameVisible ? 'is-open' : 'is-masked'}`}
                  >
                    <div className={`frame-box ${transformMode ? 'is-transformable' : ''}`} style={frameBoxStyle}>
                      {cropMode ? (
                        <>
                          <button
                            className="frame-dragger"
                            onPointerDown={(event) => startInteraction('frame-move', outputFrame, event)}
                            aria-label="Move frame"
                          />
                          <button
                            className="frame-resizer"
                            onPointerDown={(event) => startInteraction('frame-resize', outputFrame, event)}
                            aria-label="Resize frame"
                          />
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {isOriginalVideoPlaying ? (
                  <div className="preview-suspended">GIF preview paused while video plays</div>
                ) : null}
              </div>
            </div>

            <div className="preview-toolbar">
              <div className="toolbar-group toolbar-group-left">
                <button
                  className={`ghost-button tool-button ${transformMode ? 'is-active' : ''}`}
                  onClick={() => setTransformMode((current) => !current)}
                >
                  Transform
                </button>
                <button
                  className={`ghost-button tool-button ${cropMode ? 'is-active' : ''}`}
                  onClick={handleCropToggle}
                >
                  Crop
                </button>
                <button className="ghost-button tool-button" onClick={resetViewport}>
                  Reset View
                </button>
              </div>
              <div className="toolbar-slider">
                <label className="field-label">Scale</label>
                <input
                  className="timeline-slider"
                  type="range"
                  min={MIN_SCALE}
                  max={MAX_SCALE}
                  step="0.01"
                  value={sceneTransform.scale}
                  onChange={(event) =>
                    setSceneTransform((current) => ({
                      ...current,
                      scale: clamp(Number(event.target.value), MIN_SCALE, MAX_SCALE),
                    }))
                  }
                />
                <span className="zoom-readout">{sceneTransform.scale.toFixed(2)}x</span>
              </div>
              <div className="toolbar-group toolbar-group-right">
                <label className="toolbar-toggle">
                  <input
                    type="checkbox"
                    checked={showOutsideFrame}
                    onChange={(event) => setShowOutsideFrame(event.target.checked)}
                  />
                  <span>Show Outside</span>
                </label>
                <button
                  className={`ratio-button ${framePreset === 'none' ? 'is-active' : ''}`}
                  onClick={() => applyFramePreset('none')}
                >
                  No Frame
                </button>
                <button
                  className={`ratio-button ${framePreset === '1:1' ? 'is-active' : ''}`}
                  onClick={() => applyFramePreset('1:1')}
                >
                  1:1
                </button>
                <button
                  className={`ratio-button ${framePreset === '16:9' ? 'is-active' : ''}`}
                  onClick={() => applyFramePreset('16:9')}
                >
                  16:9
                </button>
                <button
                  className={`ratio-button ${framePreset === '9:16' ? 'is-active' : ''}`}
                  onClick={() => applyFramePreset('9:16')}
                >
                  9:16
                </button>
              </div>
            </div>

            {inputMode === 'video' ? (
              <div className="thumb-tools">
                <button className="ghost-button tiny-button" onClick={handleZipExport} disabled={!visibleFrames.length || isBusy}>
                  {isZipExporting ? 'ZIP...' : 'Export ZIP'}
                </button>
              </div>
            ) : null}

            <div className="thumb-strip thumb-strip-wide">
              {visibleFrames.map((frame, index) => (
                <div
                  key={frame.id}
                  className={`thumb-card ${selectedId === frame.id ? 'is-active' : ''} ${visibleFrames.length > 1 ? 'is-draggable' : ''} ${draggedFrameId === frame.id ? 'is-dragging' : ''} ${dropTargetFrameId === frame.id && draggedFrameId !== frame.id ? 'is-drop-target' : ''}`}
                  draggable={visibleFrames.length > 1}
                  onDragStart={(event) => handleThumbDragStart(frame.id, event)}
                  onDragOver={(event) => handleThumbDragOver(frame.id, event)}
                  onDrop={(event) => handleThumbDrop(frame.id, event)}
                  onDragEnd={clearThumbDragState}
                >
                  <button
                    className="thumb-remove"
                    aria-label={`${frame.name} kaldir`}
                    onClick={() => handleRemoveFrame(frame.id)}
                  >
                    ×
                  </button>
                  <button
                    className="thumb-card-select"
                    onMouseEnter={() => handlePreviewHover(frame.id, index)}
                    onFocus={() => handlePreviewHover(frame.id, index)}
                    onClick={() => handlePreviewHover(frame.id, index)}
                  >
                    <img src={frame.url} alt={frame.name} />
                    <span>{frame.name}</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
