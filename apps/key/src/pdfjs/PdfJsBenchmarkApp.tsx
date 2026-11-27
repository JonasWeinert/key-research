import { ManagedPdfTransport } from './managed-pdf-source';
import { managedSourceFor } from './reader-model';
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type {
  NativeBounds,
  NativeLink,
  PaperPreprocessingResult,
  ScholarlyMetadata,
  ScientificCitation,
} from '../engines/types';
import { Icon } from '../ui/Icon';
import { MarkdownEditor, MarkdownContent } from '../ui/MarkdownEditor';
import { AnnotationText, HighlightInfo, type HighlightUsage } from './HighlightInfo';
import { EmptyState, IconButton, PanelShell } from '../ui/primitives';
import { useReaderOverlay } from './reader-dismiss';
import {
  annotationId,
  boundsForRange,
  closeNativeCompanion,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_RGB,
  hasNativeCompanionText,
  isTauri,
  loadCanonicalAnnotations,
  openNativeCompanion,
  releaseNativeCompanionText,
  saveCanonicalAnnotations,
  searchReaderDocument,
  upsertAnnotationComment,
  watchNativeCompanion,
  type HighlightColor,
  type ReaderAnnotation,
  type ReaderSearchMatch,
  type SelectionSnapshot,
  type TextRange,
} from './reader-model';
import { PdfJsTextOverlayManager } from './text-overlays';
import { readerHorizontalGeometry, readerPageWindow } from './reader-layout';
import {
  preprocessedScholarlyEntries,
  type ScholarlyEntry,
} from './scholarly-metadata';
import { isScholarlyResourceUrl } from './citation-details';
import { quoteZoom, zoomTransitionFrame } from './quote-zoom';
import { locateQuote } from './quote-locate';
import { CitationCardBody, ExternalWorkCardBody } from './CitationCard';
import type { LibraryWorks } from './library-works';
import { ReferenceList } from './ReferenceList';
import { SidePanel } from '../ui/SidePanel';
import { SelectionMenu, type ReaderMark, type ReaderMarkMenu, type ReaderPassage, type ReaderSelectionActions, type ReaderSelectionMode } from '../ui/SelectionMenu';
import {
  HoverCardBridge,
  anchoredFloatingCardPosition,
} from './floating-card';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Safari/WebKit versions used by current Tauri builds expose ReadableStream
// but not its async-iterator protocol. PDF.js getTextContent() consumes its
// worker stream with `for await`, so provide the standards-compatible bridge
// until the host WebKit implements it natively.
const readableStreamPrototype = globalThis.ReadableStream?.prototype as
  | (ReadableStream & {
      [Symbol.asyncIterator]?: () => AsyncGenerator<unknown, void, unknown>;
    })
  | undefined;
if (readableStreamPrototype && !readableStreamPrototype[Symbol.asyncIterator]) {
  Object.defineProperty(readableStreamPrototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* (this: ReadableStream<unknown>) {
      const reader = this.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          yield result.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}

const TILE_PHYSICAL_PX = 512;
const MAX_RENDER_BYTES = 96 * 1024 * 1024;
const THUMBNAIL_WIDTH = 168;
const MAX_FALLBACK_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_RENDERS = 2;
const PAGE_GAP_CSS_PX = 16;
const PAGE_PADDING_CSS_PX = 24;
/** Matches the `top/right/bottom` inset of `.key-panel-shell` in styles.css. */
const PANEL_EDGE_GAP = 10;
let pdfJsDestructionBarrier: Promise<void> = Promise.resolve();

interface PageState {
  index: number;
  left: number;
  page: PDFPageProxy;
  baseWidth: number;
  baseHeight: number;
  top: number;
  width: number;
  height: number;
  element: HTMLDivElement;
  fallbackCanvas?: HTMLCanvasElement;
  fallbackLastUsed: number;
}

interface TileSpec {
  key: string;
  pageIndex: number;
  rasterWidth: number;
  rasterHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  distance: number;
}

interface TileRecord extends TileSpec {
  canvas: HTMLCanvasElement;
  bytes: number;
  lastUsed: number;
}

interface PendingTile {
  task: RenderTask;
  revision: number;
}

interface SettleResult {
  durationMs: number;
  timedOut: boolean;
}

export interface PdfJsViewState {
  zoom: number;
  pageIndex: number;
  pageOffsetFraction: number;
  horizontalFraction: number;
}

export interface PdfJsPreview {
  pageIndex: number;
  dataUrl: string;
}

interface FrameSummary {
  median: number;
  p95: number;
  maximum: number;
  framesOver20Ms: number;
}

export interface PdfJsBenchmarkResult {
  schemaVersion: 1;
  renderer: 'pdfjs-canvas-tiles';
  userAgent: string;
  startedAt: string;
  pageCount: number;
  sourceBytes: number;
  loadMs: number;
  featureSetupMs: number;
  interactionMs: number;
  frameIntervals: FrameSummary;
  exactRenderSettleMs: {
    median: number;
    p95: number;
    maximum: number;
    timeouts: number;
  };
  cache: {
    budgetBytes: number;
    residentBytes: number;
    residentTiles: number;
    peakResidentBytes: number;
    peakResidentTiles: number;
    fallbackBytes: number;
    fallbackBudgetBytes: number;
  };
  scenario: {
    scrollJumps: 8;
    zoomChanges: 6;
  };
}

declare global {
  interface Window {
    __PDFJS_RUN_BENCHMARK__?: () => Promise<void>;
    __PDFJS_READY__?: boolean;
    __PDFJS_ERROR__?: string;
    __PDFJS_BENCHMARK_RESULT__?: PdfJsBenchmarkResult;
    __PDFJS_FEATURES_READY__?: boolean;
  }
}

const nextFrames = (count: number) =>
  new Promise<void>(resolve => {
    const tick = () => {
      count -= 1;
      if (count <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const percentile = (values: number[], fraction: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

export class PdfJsTileController {
  private static readonly controllers = new Set<PdfJsTileController>();
  private static rebalanceBudgets() {
    const active = [...this.controllers].filter(c => !c.destroyed && !c.suspended);
    for (const controller of active) {
      controller.maxRenderBytes = Math.max(
        Math.min(controller.configuredRenderBytes, MAX_RENDER_BYTES / Math.max(1, active.length)),
        controller.viewportTileBytes(),
      );
      controller.evict();
    }
  }
  private readonly scroll: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly document: PDFDocumentProxy;
  private readonly pages: PageState[];
  private readonly pageLoads = new Map<number, Promise<PDFPageProxy>>();
  private readonly loadedPages = new Set<number>();
  private readonly mountedPages = new Set<number>();
  private readonly dpr: number;
  private readonly configuredRenderBytes: number;
  private maxRenderBytes: number;
  private readonly cache = new Map<string, TileRecord>();
  private readonly pending = new Map<string, PendingTile>();
  private readonly fallbackTasks = new Map<number, RenderTask>();
  private readonly thumbnails = new Map<number, Promise<string | null>>();
  private readonly fallbackKeys = new Set<string>();
  private desiredVisible = new Set<string>();
  private desiredAll = new Set<string>();
  private queue: TileSpec[] = [];
  private revision = 0;
  private zoom = 1;
  private fitScale = 1;
  private residentBytes = 0;
  private peakResidentBytes = 0;
  private peakResidentTiles = 0;
  private fallbackBytes = 0;
  private currentVisiblePages = new Set<number>();
  private scrollFrame = 0;
  private resizeFrame = 0;
  private wheelZoomTimer = 0;
  private wheelZoomTarget: number | null = null;
  private wheelZoomAnchor: { clientX: number; clientY: number } | null = null;
  /** Width a floating panel currently covers on the trailing edge. */
  private panelInset = 0;
  /** Height a floating toolbar covers at the top: the document starts below it. */
  private topInset = 0;
  private zoomAnimation = 0;
  private destroyed = false;
  private suspended = false;
  private activeRenders = 0;
  private visiblePagesListener?: (pages: number[]) => void;
  private zoomListener?: (zoom: number) => void;
  private viewStateListener?: (state: PdfJsViewState) => void;
  private previewListener?: (preview: PdfJsPreview) => void;
  private readonly resizeObserver?: ResizeObserver;
  private gestureStart:
    | { distance: number; zoom: number; clientX: number; clientY: number }
    | undefined;
  private panStart:
    | {
        pointerId: number;
        clientX: number;
        clientY: number;
        scrollLeft: number;
        scrollTop: number;
      }
    | undefined;

  constructor(
    scroll: HTMLDivElement,
    content: HTMLDivElement,
    document: PDFDocumentProxy,
    sourcePages: Array<{ page: PDFPageProxy; width: number; height: number }>,
    maxRenderBytes = MAX_RENDER_BYTES,
  ) {
    this.scroll = scroll;
    this.content = content;
    this.document = document;
    this.configuredRenderBytes = maxRenderBytes;
    this.maxRenderBytes = maxRenderBytes;
    this.dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    this.pages = sourcePages.map(({ page, width, height }, pageIndex) => {
      const element = documentElement('div', 'pdfjs-page');
      element.dataset.pageIndex = String(pageIndex);
      return {
        index: pageIndex,
        left: 0,
        getPage: () => this.loadPage(pageIndex),
        page,
        baseWidth: width,
        baseHeight: height,
        top: 0,
        width: width,
        height: height,
        element,
        fallbackLastUsed: 0,
      };
    });
    this.scroll.addEventListener('scroll', this.onScroll, { passive: true });
    this.scroll.addEventListener('wheel', this.onWheel, { passive: false });
    this.scroll.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.scroll.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.scroll.addEventListener('touchend', this.onTouchEnd, { passive: true });
    this.scroll.addEventListener('pointerdown', this.onPointerDown);
    this.scroll.addEventListener('pointermove', this.onPointerMove);
    this.scroll.addEventListener('pointerup', this.onPointerEnd);
    this.scroll.addEventListener('pointercancel', this.onPointerEnd);
    PdfJsTileController.controllers.add(this);
    this.updateLayout();
    this.replaceDemand();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.destroyed || this.resizeFrame) return;
        this.resizeFrame = requestAnimationFrame(() => {
          this.resizeFrame = 0;
          if (this.destroyed) return;
          // Read the place here, not when the resize was seen: a scroll made in between
          // (as a side panel closes) must not be undone by the new layout.
          const state = this.currentViewState();
          this.updateLayout();
          this.restoreAfterLayout(state);
        });
      });
      this.resizeObserver.observe(this.scroll);
    }
  }

  private loadPage(index: number): Promise<PDFPageProxy> {
    const host = this.pages[index];
    if (this.loadedPages.has(index)) return Promise.resolve(host.page);
    let pending = this.pageLoads.get(index);
    if (!pending) {
      pending = this.document.getPage(index + 1).then(page => {
        if (this.destroyed) return page;
        const state = this.currentViewState();
        const viewport = page.getViewport({ scale: 1 });
        const changed = host.baseWidth !== viewport.width || host.baseHeight !== viewport.height;
        host.page = page; host.baseWidth = viewport.width; host.baseHeight = viewport.height;
        this.loadedPages.add(index);
        if (changed) { this.updateLayout(); this.restoreAfterLayout(state); }
        return page;
      }).finally(() => this.pageLoads.delete(index));
      this.pageLoads.set(index, pending);
    }
    return pending;
  }

  preparePage(index: number) { return this.loadPage(index); }

  /** A small JPEG of a page for previews, rendered once and kept for the document's life. */
  thumbnail(index: number): Promise<string | null> {
    let pending = this.thumbnails.get(index);
    if (!pending) {
      pending = this.loadPage(index)
        .then(async page => {
          if (this.destroyed) return null;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (THUMBNAIL_WIDTH * this.dpr) / base.width });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({
            canvas: null,
            canvasContext: canvas.getContext('2d', { alpha: false })!,
            viewport,
            background: '#ffffff',
          }).promise;
          return canvas.toDataURL('image/jpeg', 0.82);
        })
        .catch(() => {
          this.thumbnails.delete(index);
          return null;
        });
      this.thumbnails.set(index, pending);
    }
    return pending;
  }

  /** A region of a page as an image (reading mode's figures and tables); `rect` is
   * [x, y, width, height] in 0–65535 of the page, `width` the image's CSS width. */
  async renderRegion(index: number, rect: number[], width: number): Promise<string | null> {
    if (this.destroyed) return null;
    const page = await this.loadPage(index);
    const base = page.getViewport({ scale: 1 });
    const [x, y, w, h] = rect.map(v => v / 65535);
    const scale = Math.min(4, (width * this.dpr) / Math.max(1, base.width * w));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width * w));
    canvas.height = Math.max(1, Math.ceil(viewport.height * h));
    const context = canvas.getContext('2d', { alpha: false })!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvas: null,
      canvasContext: context,
      viewport,
      transform: [1, 0, 0, 1, -viewport.width * x, -viewport.height * y],
      background: '#ffffff',
    }).promise;
    return canvas.toDataURL('image/png');
  }

  pageCount() {
    return this.pages.length;
  }

  pageHosts() {
    return this.pages;
  }

  currentZoom() {
    return this.zoom;
  }

  setPanelInset(inset: number) {
    const normalized = Math.max(0, Math.ceil(inset));
    if (normalized === this.panelInset) return;
    this.panelInset = normalized;
    this.updateLayout();
    this.replaceDemand();
  }

  setTopInset(inset: number) {
    const normalized = Math.max(0, Math.ceil(inset));
    if (normalized === this.topInset) return;
    this.topInset = normalized;
    this.updateLayout();
    this.replaceDemand();
  }

  fitWidth() {
    this.setZoom(1);
  }

  actualSize() {
    this.setZoom(1 / Math.max(0.05, this.fitScale));
  }

  onVisiblePages(listener: (pages: number[]) => void) {
    this.visiblePagesListener = listener;
    this.replaceDemand();
  }

  onZoomChange(listener: (zoom: number) => void) {
    this.zoomListener = listener;
  }

  onViewStateChange(listener: (state: PdfJsViewState) => void) {
    this.viewStateListener = listener;
    listener(this.currentViewState());
  }

  onPreviewChange(listener: (preview: PdfJsPreview) => void) {
    this.previewListener = listener;
    const visiblePage = [...this.currentVisiblePages][0];
    const canvas =
      this.pages[visiblePage]?.fallbackCanvas ??
      this.pages.find(page => page.fallbackCanvas)?.fallbackCanvas;
    if (canvas) {
      listener({
        pageIndex: visiblePage ?? 0,
        dataUrl: canvas.toDataURL('image/jpeg', 0.72),
      });
    }
  }

  currentViewState(): PdfJsViewState {
    const anchorY = this.scroll.scrollTop + this.scroll.clientHeight * 0.32;
    const page =
      this.pages.find(
        candidate =>
          anchorY >= candidate.top && anchorY <= candidate.top + candidate.height,
      ) ??
      this.pages.reduce(
        (nearest, candidate) =>
          Math.abs(candidate.top - anchorY) < Math.abs(nearest.top - anchorY)
            ? candidate
            : nearest,
        this.pages[0],
      );
    const horizontalMaximum = Math.max(
      0,
      this.content.scrollWidth - this.scroll.clientWidth,
    );
    return {
      zoom: this.zoom,
      pageIndex: page?.index ?? 0,
      pageOffsetFraction: page
        ? Math.min(1, Math.max(0, (anchorY - page.top) / Math.max(1, page.height)))
        : 0,
      horizontalFraction:
        horizontalMaximum > 0 ? this.scroll.scrollLeft / horizontalMaximum : 0,
    };
  }

  /** After a new layout: a reader at the very top stays there (the place it keeps is 32%
   *  down the view, which a new width would otherwise move down the first page). */
  private restoreAfterLayout(state: PdfJsViewState) {
    const atTop = this.scroll.scrollTop <= 1;
    if (!atTop) return this.restoreViewState(state);
    this.restoreViewState({ ...state, pageIndex: 0, pageOffsetFraction: 0 });
    this.scroll.scrollTop = 0;
  }

  restoreViewState(state: PdfJsViewState) {
    this.setZoom(state.zoom);
    const page = this.pages[Math.min(this.pages.length - 1, Math.max(0, state.pageIndex))];
    if (page) {
      this.scroll.scrollTop = Math.max(
        0,
        page.top +
          Math.min(1, Math.max(0, state.pageOffsetFraction)) * page.height -
          this.scroll.clientHeight * 0.32,
      );
    }
    const horizontalMaximum = Math.max(
      0,
      this.content.scrollWidth - this.scroll.clientWidth,
    );
    this.scroll.scrollLeft =
      horizontalMaximum * Math.min(1, Math.max(0, state.horizontalFraction));
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  scrollToFraction(fraction: number) {
    const maximum = Math.max(0, this.content.scrollHeight - this.scroll.clientHeight);
    this.scroll.scrollTop = maximum * Math.min(1, Math.max(0, fraction));
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  scrollByPixels(left: number, top: number) {
    this.scroll.scrollBy({ left, top, behavior: 'instant' });
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  currentScrollFraction() {
    const maximum = Math.max(0, this.content.scrollHeight - this.scroll.clientHeight);
    return maximum > 0 ? this.scroll.scrollTop / maximum : 0;
  }

  setZoom(nextZoom: number, clientX?: number, clientY?: number) {
    this.stopZoomAnimation();
    if (this.wheelZoomTimer) {
      window.clearTimeout(this.wheelZoomTimer);
      this.wheelZoomTimer = 0;
    }
    this.wheelZoomTarget = null;
    this.wheelZoomAnchor = null;
    this.content.style.transform = '';
    this.content.style.transformOrigin = '';
    const clamped = Math.min(5, Math.max(0.2, nextZoom));
    if (Math.abs(clamped - this.zoom) < 0.0001) return;
    const scrollRect = this.scroll.getBoundingClientRect();
    const localX =
      clientX === undefined ? this.scroll.clientWidth / 2 : clientX - scrollRect.left;
    const localY =
      clientY === undefined ? this.scroll.clientHeight / 2 : clientY - scrollRect.top;
    const anchorX = this.scroll.scrollLeft + localX;
    const anchorY = this.scroll.scrollTop + localY;
    const anchorPage = this.pages.find(
      page => anchorY >= page.top && anchorY <= page.top + page.height,
    );
    const normalizedX = anchorPage
      ? (anchorX - anchorPage.element.offsetLeft) / anchorPage.width
      : 0.5;
    const normalizedY = anchorPage ? (anchorY - anchorPage.top) / anchorPage.height : 0.5;
    const anchorIndex = anchorPage ? this.pages.indexOf(anchorPage) : 0;

    // Preserve the last complete raster grid while a pinch gesture creates a
    // stream of intermediate scales. Those canvases scale softly with their
    // page instead of exposing the white page background between new tiles.
    if (
      this.desiredVisible.size > 0 &&
      [...this.desiredVisible].every(key => this.cache.has(key))
    ) {
      this.fallbackKeys.clear();
      const visiblePages = new Set(
        [...this.desiredVisible]
          .map(key => Number(key.split(':')[0]))
          .filter(Number.isInteger),
      );
      for (const [key, record] of this.cache) {
        if (visiblePages.has(record.pageIndex)) this.fallbackKeys.add(key);
      }
    }
    this.zoom = clamped;
    this.zoomListener?.(this.zoom);
    this.revision += 1;
    this.cancelPending();
    this.updateLayout();

    const restored = this.pages[anchorIndex];
    if (restored) {
      const pageLeft = restored.element.offsetLeft;
      this.scroll.scrollLeft =
        pageLeft + normalizedX * restored.width - localX;
      this.scroll.scrollTop =
        restored.top + normalizedY * restored.height - localY;
    }
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  scrollToBounds(pageIndex: number, bounds?: NativeBounds) {
    const page = this.pages[pageIndex];
    if (!page) return;
    const targetY = page.top + (bounds?.top ?? 0) * page.height;
    const targetX =
      page.element.offsetLeft + (bounds?.left ?? 0.5) * page.width;
    this.scroll.scrollTo({
      top: Math.max(0, targetY - this.scroll.clientHeight * 0.32),
      left: Math.max(0, targetX - this.scroll.clientWidth / 2),
      behavior: 'instant',
    });
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  centerOnBounds(pageIndex: number, bounds?: NativeBounds) {
    const page = this.pages[pageIndex];
    if (!page) return;
    const targetY =
      page.top + ((bounds?.top ?? 0.5) + (bounds?.bottom ?? 0.5)) / 2 * page.height;
    const targetX =
      page.element.offsetLeft +
      ((bounds?.left ?? 0.5) + (bounds?.right ?? 0.5)) / 2 * page.width;
    this.scroll.scrollTo({
      top: Math.max(0, targetY - this.scroll.clientHeight / 2),
      left: Math.max(0, targetX - this.scroll.clientWidth / 2),
      behavior: 'smooth',
    });
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  /**
   * Brings a passage to the middle of the reading area at a zoom where it fits comfortably
   * and reads well (see quoteZoom), moving there in one smooth motion: the final layout is
   * applied at once and a transform eases from the old view into it.
   */
  zoomToBounds(pageIndex: number, bounds: NativeBounds, animate = true) {
    const page = this.pages[pageIndex];
    if (!page) return;
    this.stopZoomAnimation();
    const readingWidth = Math.max(1, this.scroll.clientWidth - this.panelInset);
    const readingHeight = Math.max(1, this.scroll.clientHeight - this.topInset);
    const fx = (bounds.left + bounds.right) / 2;
    const fy = (bounds.top + bounds.bottom) / 2;
    const fromZoom = this.zoom;
    const start = {
      x: page.left + fx * page.width - this.scroll.scrollLeft,
      y: page.top + fy * page.height - this.scroll.scrollTop,
    };
    const target = quoteZoom({
      viewport: { width: readingWidth, height: readingHeight },
      rect: {
        width: (bounds.right - bounds.left) * page.width,
        height: (bounds.bottom - bounds.top) * page.height,
      },
      zoom: this.zoom,
      pageScale: page.width / Math.max(1, page.baseWidth),
    });
    this.setZoom(target);
    const content = { x: page.left + fx * page.width, y: page.top + fy * page.height };
    this.scroll.scrollLeft = content.x - readingWidth / 2;
    this.scroll.scrollTop = content.y - (this.topInset + readingHeight / 2);
    const scroll = { x: this.scroll.scrollLeft, y: this.scroll.scrollTop };
    const end = { x: content.x - scroll.x, y: content.y - scroll.y };
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
    const still =
      Math.abs(target - fromZoom) < 0.001 && Math.hypot(end.x - start.x, end.y - start.y) < 2;
    if (!animate || still || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const duration = 380;
    const began = performance.now();
    this.content.style.transformOrigin = '0 0';
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / duration);
      const frame = zoomTransitionFrame(t, { content, start, end }, scroll, fromZoom, target);
      this.content.style.transform =
        t >= 1 ? '' : `translate(${frame.translateX}px, ${frame.translateY}px) scale(${frame.scale})`;
      if (t >= 1) {
        this.zoomAnimation = 0;
        this.content.style.transformOrigin = '';
        return;
      }
      this.zoomAnimation = requestAnimationFrame(step);
    };
    step(began);
  }

  private stopZoomAnimation() {
    if (!this.zoomAnimation) return;
    cancelAnimationFrame(this.zoomAnimation);
    this.zoomAnimation = 0;
    this.content.style.transform = '';
    this.content.style.transformOrigin = '';
  }

  async waitForExact(timeoutMs = 5000): Promise<SettleResult> {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      if (
        this.desiredVisible.size > 0 &&
        [...this.desiredVisible].every(key => this.cache.has(key))
      ) {
        return { durationMs: performance.now() - start, timedOut: false };
      }
      await nextFrames(1);
    }
    return { durationMs: timeoutMs, timedOut: true };
  }

  cacheMetrics() {
    return {
      budgetBytes: this.maxRenderBytes,
      residentBytes: this.residentBytes,
      residentTiles: this.cache.size,
      mountedPages: this.mountedPages.size,
      peakResidentBytes: this.peakResidentBytes,
      peakResidentTiles: this.peakResidentTiles,
      fallbackBytes: this.fallbackBytes,
      fallbackBudgetBytes: MAX_FALLBACK_BYTES,
      suspended: this.suspended,
    };
  }

  suspendRaster(keepFallback: boolean) {
    this.suspended = true;
    PdfJsTileController.rebalanceBudgets();
    this.revision += 1;
    this.cancelPending();
    for (const task of this.fallbackTasks.values()) task.cancel();
    this.fallbackKeys.clear();
    this.desiredVisible.clear();
    this.desiredAll.clear();
    for (const [key, record] of [...this.cache]) {
      this.cache.delete(key);
      this.release(record);
    }
    if (!keepFallback) {
      for (const page of this.pages) this.releaseFallback(page);
    }
    // Releasing canvases alone is not enough: PDF.js retains decoded image,
    // font, and operator-list resources on every page proxy. A parsed-warm
    // document keeps its document/xref state, text and app layers, but lets
    // those renderer-only resources go. PDF.js will lazily reconstruct them
    // if this reader is promoted again.
    void this.document.cleanup(false).catch(() => undefined);
  }

  resumeRaster() {
    if (!this.suspended || this.destroyed) return;
    this.suspended = false;
    this.updateLayout();
    this.replaceDemand();
  }

  async destroy() {
    this.destroyed = true;
    PdfJsTileController.controllers.delete(this);
    PdfJsTileController.rebalanceBudgets();
    this.scroll.removeEventListener('scroll', this.onScroll);
    this.scroll.removeEventListener('wheel', this.onWheel);
    this.scroll.removeEventListener('touchstart', this.onTouchStart);
    this.scroll.removeEventListener('touchmove', this.onTouchMove);
    this.scroll.removeEventListener('touchend', this.onTouchEnd);
    this.scroll.removeEventListener('pointerdown', this.onPointerDown);
    this.scroll.removeEventListener('pointermove', this.onPointerMove);
    this.scroll.removeEventListener('pointerup', this.onPointerEnd);
    this.scroll.removeEventListener('pointercancel', this.onPointerEnd);
    this.resizeObserver?.disconnect();
    if (this.wheelZoomTimer) window.clearTimeout(this.wheelZoomTimer);
    if (this.zoomAnimation) cancelAnimationFrame(this.zoomAnimation);
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
    this.cancelPending();
    for (const task of this.fallbackTasks.values()) task.cancel();
    this.fallbackTasks.clear();
    this.fallbackKeys.clear();
    for (const record of this.cache.values()) this.release(record);
    this.cache.clear();
    for (const page of this.pages) this.releaseFallback(page);
    this.content.replaceChildren();
    await this.document.loadingTask.destroy();
  }

  private lastInteractionReport = -Infinity;
  private reportInteraction() {
    const now = performance.now();
    if (isTauri() && now - this.lastInteractionReport >= 250) {
      this.lastInteractionReport = now;
      void invoke('processing_interaction').catch(() => undefined);
    }
  }

  private readonly onScroll = () => {
    this.reportInteraction();
    // Capture navigation state while the pane is still attached. React runs
    // passive unmount cleanup after removing the old DOM, at which point
    // WebKit reports scrollTop as zero.
    this.viewStateListener?.(this.currentViewState());
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.replaceDemand();
    });
  };

  private readonly onWheel = (event: WheelEvent) => {
    this.reportInteraction();
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.stopZoomAnimation();
    const currentTarget = this.wheelZoomTarget ?? this.zoom;
    const target = Math.min(
      5,
      Math.max(0.2, currentTarget * Math.exp(-event.deltaY * 0.012)),
    );
    this.wheelZoomTarget = target;
    this.wheelZoomAnchor = { clientX: event.clientX, clientY: event.clientY };
    const scrollRect = this.scroll.getBoundingClientRect();
    const localX = this.scroll.scrollLeft + event.clientX - scrollRect.left;
    const localY = this.scroll.scrollTop + event.clientY - scrollRect.top;
    this.content.style.transformOrigin = `${localX}px ${localY}px`;
    this.content.style.transform = `scale(${target / this.zoom})`;
    if (this.wheelZoomTimer) window.clearTimeout(this.wheelZoomTimer);
    this.wheelZoomTimer = window.setTimeout(() => {
      this.wheelZoomTimer = 0;
      const committed = this.wheelZoomTarget;
      const anchor = this.wheelZoomAnchor;
      if (committed === null || !anchor) return;
      this.setZoom(committed, anchor.clientX, anchor.clientY);
    }, 120);
  };

  private readonly onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 2) return;
    const [first, second] = [event.touches[0], event.touches[1]];
    this.gestureStart = {
      distance: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY),
      zoom: this.zoom,
      clientX: (first.clientX + second.clientX) / 2,
      clientY: (first.clientY + second.clientY) / 2,
    };
    event.preventDefault();
  };

  private readonly onTouchMove = (event: TouchEvent) => {
    if (!this.gestureStart || event.touches.length !== 2) return;
    const [first, second] = [event.touches[0], event.touches[1]];
    const distance = Math.hypot(
      first.clientX - second.clientX,
      first.clientY - second.clientY,
    );
    const clientX = (first.clientX + second.clientX) / 2;
    const clientY = (first.clientY + second.clientY) / 2;
    this.setZoom(
      this.gestureStart.zoom * (distance / Math.max(1, this.gestureStart.distance)),
      clientX,
      clientY,
    );
    event.preventDefault();
  };

  private readonly onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) this.gestureStart = undefined;
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    this.panStart = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: this.scroll.scrollLeft,
      scrollTop: this.scroll.scrollTop,
    };
    this.scroll.setPointerCapture(event.pointerId);
    this.scroll.classList.add('panning');
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.panStart || event.pointerId !== this.panStart.pointerId) return;
    event.preventDefault();
    this.scroll.scrollLeft =
      this.panStart.scrollLeft - (event.clientX - this.panStart.clientX);
    this.scroll.scrollTop =
      this.panStart.scrollTop - (event.clientY - this.panStart.clientY);
  };

  private readonly onPointerEnd = (event: PointerEvent) => {
    if (!this.panStart || event.pointerId !== this.panStart.pointerId) return;
    this.panStart = undefined;
    if (this.scroll.hasPointerCapture(event.pointerId)) {
      this.scroll.releasePointerCapture(event.pointerId);
    }
    this.scroll.classList.remove('panning');
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  };

  /**
   * Bytes needed to hold everything currently on screen plus the one-tile
   * overscan ring `replaceDemand` asks for. A retained reader whose budget is
   * below this can never keep its own visible set — it evicts tiles it is
   * about to be asked for again, so switching back to it is never warm.
   */
  private viewportTileBytes() {
    const columns = Math.ceil((this.scroll.clientWidth * this.dpr) / TILE_PHYSICAL_PX) + 2;
    const rows = Math.ceil((this.scroll.clientHeight * this.dpr) / TILE_PHYSICAL_PX) + 2;
    return columns * rows * TILE_PHYSICAL_PX * TILE_PHYSICAL_PX * 4;
  }

  private updateLayout() {
    // The budget follows the window: a fixed constant is either wasteful on a
    // small window or below the visible set on a large one.
    PdfJsTileController.rebalanceBudgets();
    const widest = Math.max(1, ...this.pages.map(page => page.baseWidth));
    this.fitScale = Math.max(
      0.05,
      (this.scroll.clientWidth - PAGE_PADDING_CSS_PX * 2) / widest,
    );
    const scale = this.fitScale * this.zoom;
    const geometry = readerHorizontalGeometry(
      this.scroll.clientWidth,
      widest * scale,
      PAGE_PADDING_CSS_PX,
      this.panelInset,
    );
    const baseContentWidth = geometry.baseContentWidth;
    let top = PAGE_PADDING_CSS_PX + this.topInset;
    for (const page of this.pages) {
      page.width = page.baseWidth * scale;
      page.height = page.baseHeight * scale;
      page.top = top;
      page.left = geometry.pageLeft(page.width);
      if (this.mountedPages.has(page.index)) this.placePageShell(page);
      top += page.height + PAGE_GAP_CSS_PX;
    }
    this.content.style.height = `${Math.max(this.scroll.clientHeight, top + PAGE_PADDING_CSS_PX)}px`;
    this.content.style.minWidth = `${geometry.contentWidth}px`;
  }

  private placePageShell(page: PageState) {
    page.element.style.width = `${page.width}px`;
    page.element.style.height = `${page.height}px`;
    page.element.style.setProperty('--page-height', `${page.height}px`);
    page.element.style.top = `${page.top}px`;
    page.element.style.left = `${page.left}px`;
  }

  private mountPageWindow(first: number, last: number) {
    for (const index of this.mountedPages) {
      if (index < first || index >= last) {
        this.pages[index].element.remove();
        this.mountedPages.delete(index);
      }
    }
    for (let index = first; index < last; index += 1) {
      if (!this.mountedPages.has(index)) {
        const page = this.pages[index];
        this.placePageShell(page);
        this.content.append(page.element);
        this.mountedPages.add(index);
      }
    }
  }

  private cleanOffscreenPages() {
    for (const index of this.loadedPages) {
      if (this.mountedPages.has(index) || this.fallbackTasks.has(index) || this.pageLoads.has(index)) continue;
      this.pages[index].page.cleanup();
    }
  }

  private replaceDemand() {
    if (this.destroyed || this.suspended || this.pages.length === 0) return;
    // Low-resolution backings are background work. If the user moves, tiles win.
    for (const task of this.fallbackTasks.values()) task.cancel();
    this.revision += 1;
    const revision = this.revision;
    const viewportTop = this.scroll.scrollTop;
    const viewportBottom = viewportTop + this.scroll.clientHeight;
    const viewportLeft = this.scroll.scrollLeft;
    const viewportRight = viewportLeft + this.scroll.clientWidth;
    const specs: TileSpec[] = [];

    const overscanCss = TILE_PHYSICAL_PX / this.dpr;
    const [firstPage, lastPage] = readerPageWindow(this.pages, viewportTop - overscanCss, viewportBottom + overscanCss);
    this.mountPageWindow(firstPage, lastPage);
    for (let pageIndex = firstPage; pageIndex < lastPage; pageIndex += 1) {
      const page = this.pages[pageIndex];
      const pageLeft = page.left;
      const left = Math.max(pageLeft, viewportLeft - overscanCss);
      const right = Math.min(pageLeft + page.width, viewportRight + overscanCss);
      const top = Math.max(page.top, viewportTop - overscanCss);
      const bottom = Math.min(page.top + page.height, viewportBottom + overscanCss);
      if (left >= right || top >= bottom) continue;

      const rasterWidth = Math.max(1, Math.ceil(page.width * this.dpr));
      const rasterHeight = Math.max(1, Math.ceil(page.height * this.dpr));
      const firstColumn = Math.max(
        0,
        Math.floor(((left - pageLeft) * this.dpr) / TILE_PHYSICAL_PX),
      );
      const lastColumn = Math.min(
        Math.ceil(rasterWidth / TILE_PHYSICAL_PX) - 1,
        Math.floor((((right - pageLeft) * this.dpr) - 1) / TILE_PHYSICAL_PX),
      );
      const firstRow = Math.max(
        0,
        Math.floor(((top - page.top) * this.dpr) / TILE_PHYSICAL_PX),
      );
      const lastRow = Math.min(
        Math.ceil(rasterHeight / TILE_PHYSICAL_PX) - 1,
        Math.floor((((bottom - page.top) * this.dpr) - 1) / TILE_PHYSICAL_PX),
      );

      for (let row = firstRow; row <= lastRow; row += 1) {
        for (let column = firstColumn; column <= lastColumn; column += 1) {
          const x = column * TILE_PHYSICAL_PX;
          const y = row * TILE_PHYSICAL_PX;
          const width = Math.min(TILE_PHYSICAL_PX, rasterWidth - x);
          const height = Math.min(TILE_PHYSICAL_PX, rasterHeight - y);
          const tileLeft = pageLeft + x / this.dpr;
          const tileTop = page.top + y / this.dpr;
          const tileRight = tileLeft + width / this.dpr;
          const tileBottom = tileTop + height / this.dpr;
          const visible =
            tileRight > viewportLeft &&
            tileLeft < viewportRight &&
            tileBottom > viewportTop &&
            tileTop < viewportBottom;
          const centerX = tileLeft + width / this.dpr / 2;
          const centerY = tileTop + height / this.dpr / 2;
          const key = `${pageIndex}:${rasterWidth}x${rasterHeight}:${column}:${row}`;
          specs.push({
            key,
            pageIndex,
            rasterWidth,
            rasterHeight,
            x,
            y,
            width,
            height,
            visible,
            distance:
              (centerX - (viewportLeft + this.scroll.clientWidth / 2)) ** 2 +
              (centerY - (viewportTop + this.scroll.clientHeight / 2)) ** 2,
          });
        }
      }
    }

    specs.sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance);
    this.desiredVisible = new Set(specs.filter(spec => spec.visible).map(spec => spec.key));
    this.desiredAll = new Set(specs.map(spec => spec.key));
    const visiblePages = [
      ...new Set(specs.filter(spec => spec.visible).map(spec => spec.pageIndex)),
    ];
    this.currentVisiblePages = new Set(visiblePages);
    // Old zoom grids only protect pages that remain visible. Otherwise rapid
    // zoom/scroll could pin old canvases outside the eviction budget forever.
    for (const key of this.fallbackKeys) {
      if (!this.currentVisiblePages.has(Number(key.split(':')[0]))) this.fallbackKeys.delete(key);
    }
    const fallbackNow = performance.now();
    for (const pageIndex of visiblePages) {
      this.pages[pageIndex].fallbackLastUsed = fallbackNow;
    }
    this.visiblePagesListener?.(visiblePages);
    for (const [key, pending] of this.pending) {
      if (!this.desiredAll.has(key)) {
        pending.task.cancel();
        this.pending.delete(key);
      }
    }
    const now = performance.now();
    for (const spec of specs) {
      const cached = this.cache.get(spec.key);
      if (cached) cached.lastUsed = now;
    }
    this.queue = specs.filter(spec => !this.cache.has(spec.key) && !this.pending.has(spec.key));
    this.evict();
    this.pump(revision);
    this.warmFallbackWhenIdle();
    this.cleanOffscreenPages();
  }

  private pump(revision: number) {
    while (
      !this.destroyed &&
      !this.suspended &&
      this.activeRenders < MAX_CONCURRENT_RENDERS &&
      this.queue.length > 0
    ) {
      const spec = this.queue.shift();
      if (!spec || !this.desiredAll.has(spec.key) || this.cache.has(spec.key)) continue;
      void this.render(spec, revision);
    }
  }

  private async render(spec: TileSpec, revision: number) {
    const pageState = this.pages[spec.pageIndex];
    if (!pageState) return;
    if (!this.loadedPages.has(spec.pageIndex)) {
      this.activeRenders += 1;
      try { await this.loadPage(spec.pageIndex); }
      catch (error) { console.error("PDF page load failed", error); this.suspended = true; }
      finally { this.activeRenders -= 1; if (!this.destroyed) this.replaceDemand(); }
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = spec.width;
    canvas.height = spec.height;
    canvas.className = 'pdfjs-tile';
    canvas.dataset.tileKey = spec.key;
    const viewport = pageState.page.getViewport({
      scale: spec.rasterWidth / pageState.baseWidth,
    });
    const task = pageState.page.render({
      canvas: null,
      canvasContext: canvas.getContext('2d', { alpha: false })!,
      viewport,
      transform: [1, 0, 0, 1, -spec.x, -spec.y],
      background: '#ffffff',
    });
    this.pending.set(spec.key, { task, revision });
    this.activeRenders += 1;
    try {
      await task.promise;
      if (
        this.destroyed ||
        this.suspended ||
        !this.desiredAll.has(spec.key) ||
        this.pending.get(spec.key)?.revision !== revision
      ) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      const record: TileRecord = {
        ...spec,
        canvas,
        bytes: spec.width * spec.height * 4,
        lastUsed: performance.now(),
      };
      this.place(record);
      this.cache.set(spec.key, record);
      this.residentBytes += record.bytes;
      this.peakResidentBytes = Math.max(this.peakResidentBytes, this.residentBytes);
      this.peakResidentTiles = Math.max(this.peakResidentTiles, this.cache.size);
      this.retireOldScaleWhenExact(spec.pageIndex);
      this.evict();
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name !== 'RenderingCancelledException' && !this.destroyed) {
        console.warn('PDF.js tile render failed', error);
      }
      canvas.width = 0;
      canvas.height = 0;
    } finally {
      if (this.pending.get(spec.key)?.revision === revision) this.pending.delete(spec.key);
      this.activeRenders = Math.max(0, this.activeRenders - 1);
      this.pump(this.revision);
      this.warmFallbackWhenIdle();
      this.cleanOffscreenPages();
    }
  }

  private place(record: TileRecord) {
    const page = this.pages[record.pageIndex];
    record.canvas.style.left = `${record.x / record.rasterWidth * 100}%`;
    record.canvas.style.top = `${record.y / record.rasterHeight * 100}%`;
    record.canvas.style.width = `${record.width / record.rasterWidth * 100}%`;
    record.canvas.style.height = `${record.height / record.rasterHeight * 100}%`;
    record.canvas.style.zIndex = '2';
    page?.element.append(record.canvas);
  }

  private retireOldScaleWhenExact(pageIndex: number) {
    const visibleForPage = [...this.desiredVisible].filter(key =>
      key.startsWith(`${pageIndex}:`),
    );
    if (visibleForPage.length === 0 || !visibleForPage.every(key => this.cache.has(key))) return;
    for (const key of [...this.fallbackKeys]) {
      if (key.startsWith(`${pageIndex}:`)) this.fallbackKeys.delete(key);
    }
    const currentPrefix = visibleForPage[0]?.split(':').slice(0, 2).join(':');
    for (const [key, record] of [...this.cache]) {
      if (
        record.pageIndex === pageIndex &&
        !key.startsWith(`${currentPrefix}:`) &&
        !this.desiredVisible.has(key)
      ) {
        this.cache.delete(key);
        this.release(record);
      }
    }
  }

  private evict() {
    if (this.residentBytes <= this.maxRenderBytes) return;
    const candidates = [...this.cache.values()]
      .filter(
        record =>
          !this.desiredVisible.has(record.key) && !this.fallbackKeys.has(record.key),
      )
      .sort((a, b) => {
        const aCurrent = this.desiredAll.has(a.key);
        const bCurrent = this.desiredAll.has(b.key);
        return Number(aCurrent) - Number(bCurrent) || a.lastUsed - b.lastUsed;
      });
    for (const record of candidates) {
      if (this.residentBytes <= this.maxRenderBytes) break;
      this.cache.delete(record.key);
      this.release(record);
    }
  }

  private release(record: TileRecord) {
    this.fallbackKeys.delete(record.key);
    record.canvas.remove();
    record.canvas.width = 0;
    record.canvas.height = 0;
    this.residentBytes = Math.max(0, this.residentBytes - record.bytes);
  }

  private cancelPending() {
    for (const pending of this.pending.values()) pending.task.cancel();
    this.pending.clear();
    this.queue = [];
  }

  private async ensurePageFallback(pageIndex: number) {
    const page = this.pages[pageIndex];
    if (page) page.fallbackLastUsed = performance.now();
    if (
      this.destroyed ||
      this.suspended ||
      !page ||
      page.fallbackCanvas ||
      this.fallbackTasks.has(pageIndex)
    ) {
      return;
    }
    if (!this.loadedPages.has(pageIndex)) { await this.loadPage(pageIndex); if (this.destroyed || this.suspended) return; }
    // About 0.35 MiB for an A4/Letter page: deliberately soft while scaled,
    // but large enough that page structure remains recognizable during pinch.
    const rasterWidth = 256;
    const scale = rasterWidth / page.baseWidth;
    const viewport = page.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdfjs-page-fallback';
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const task = page.page.render({
      canvas: null,
      canvasContext: canvas.getContext('2d', { alpha: false })!,
      viewport,
      background: '#ffffff',
    });
    this.fallbackTasks.set(pageIndex, task);
    try {
      await task.promise;
      if (this.destroyed || this.suspended || page.fallbackCanvas) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      page.fallbackCanvas = canvas;
      this.fallbackBytes += canvas.width * canvas.height * 4;
      page.element.prepend(canvas);
      if (this.currentVisiblePages.has(pageIndex)) {
        this.previewListener?.({
          pageIndex,
          dataUrl: canvas.toDataURL('image/jpeg', 0.72),
        });
      }
      this.evictFallbacks();
    } catch (error) {
      if ((error instanceof Error ? error.name : '') !== 'RenderingCancelledException') {
        console.warn('PDF.js fallback render failed', error);
      }
      canvas.width = 0;
      canvas.height = 0;
    } finally {
      this.fallbackTasks.delete(pageIndex);
      this.warmFallbackWhenIdle();
    }
  }

  private warmFallbackWhenIdle() {
    if (
      this.destroyed ||
      this.suspended ||
      this.activeRenders > 0 ||
      this.queue.length > 0 ||
      this.fallbackTasks.size > 0
    ) {
      return;
    }
    const pageIndex = [...this.currentVisiblePages].find(
      index => !this.pages[index]?.fallbackCanvas,
    );
    if (pageIndex !== undefined) void this.ensurePageFallback(pageIndex);
  }

  private evictFallbacks() {
    if (this.fallbackBytes <= MAX_FALLBACK_BYTES) return;
    const candidates = this.pages
      .filter(
        page =>
          page.fallbackCanvas && !this.currentVisiblePages.has(page.index),
      )
      .sort((a, b) => a.fallbackLastUsed - b.fallbackLastUsed);
    for (const page of candidates) {
      if (this.fallbackBytes <= MAX_FALLBACK_BYTES) break;
      this.releaseFallback(page);
    }
  }

  private releaseFallback(page: PageState) {
    const canvas = page.fallbackCanvas;
    if (!canvas) return;
    this.fallbackBytes = Math.max(
      0,
      this.fallbackBytes - canvas.width * canvas.height * 4,
    );
    canvas.remove();
    canvas.width = 0;
    canvas.height = 0;
    page.fallbackCanvas = undefined;
  }
}

function documentElement(tag: 'div', className: string) {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

interface CommentDraft {
  range: TextRange;
  annotationId?: string;
  text: string;
  comment: string;
}

type ReaderPanel = 'search' | 'outline' | 'references' | 'comments';
interface HoveredLink {
  link: NativeLink & { synthetic?: boolean };
  rect: DOMRect;
}

interface CitationFocus {
  citation: ScientificCitation;
  rect: DOMRect;
}

interface ExternalCitationFocus {
  link: NativeLink & { synthetic?: boolean };
  rect: DOMRect;
  entry: ScholarlyEntry;
}

interface BenchmarkFixture {
  name: string;
  bytes: number[];
}

/** Where `position: fixed` puts (0, 0) for an element in `host`: the window's corner, unless an
 * ancestor contains fixed boxes (a container query's pane, a transform). Cards placed in window
 * coordinates subtract it. */
function fixedOrigin(host: Element | null | undefined): { x: number; y: number } {
  if (!host) return { x: 0, y: 0 };
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none';
  host.append(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  return { x: r.left, y: r.top };
}

interface LiveAnchoredCardProps
  extends Omit<ComponentPropsWithoutRef<'div'>, 'style'> {
  resolveAnchor: () => DOMRect | undefined;
  gap?: number;
}

function LiveAnchoredCard({
  resolveAnchor,
  gap = 10,
  children,
  ...props
}: LiveAnchoredCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  );

  const updatePosition = useCallback(() => {
    const card = cardRef.current;
    const anchor = resolveAnchor();
    if (!card || !anchor) return;
    const cardRect = card.getBoundingClientRect();
    const next = anchoredFloatingCardPosition(
      anchor,
      { width: window.innerWidth, height: window.innerHeight },
      {
        width: Math.max(1, cardRect.width),
        height: Math.max(1, cardRect.height),
      },
      gap,
    );
    // Inside the reader's box when it is narrower than the window (beside a sidebar).
    const box = card.parentElement?.getBoundingClientRect();
    if (box && box.width > cardRect.width + 16) next.left = Math.max(box.left + 8, Math.min(next.left, box.right - cardRect.width - 8));
    const origin = fixedOrigin(card.parentElement);
    next.left -= origin.x;
    next.top -= origin.y;
    setPosition(current =>
      current &&
      Math.abs(current.left - next.left) < 0.5 &&
      Math.abs(current.top - next.top) < 0.5
        ? current
        : next,
    );
  }, [gap, resolveAnchor]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updatePosition();
      });
    };
    updatePosition();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleUpdate);
    observer?.observe(card);
    document.addEventListener('scroll', scheduleUpdate, true);
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener('scroll', scheduleUpdate, true);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [updatePosition]);

  return (
    <div
      {...props}
      ref={cardRef}
      style={
        position ?? {
          left: -10_000,
          top: -10_000,
          visibility: 'hidden',
        }
      }
    >
      {children}
    </div>
  );
}

function linkPreviewText(link: NativeLink & { synthetic?: boolean }) {
  if (link.target.kind === 'internal') {
    return {
      title: link.synthetic ? 'Citation' : 'Document link',
      detail: `Go to page ${link.target.page + 1}`,
    };
  }
  try {
    return {
      title: new URL(link.target.url).hostname,
      detail: link.target.url,
    };
  } catch {
    return { title: 'External link', detail: link.target.url };
  }
}

/** Boxes [x, y, width, height] in 0–65535 of the page → fractions. */
function toBounds(rects: number[][]): NativeBounds[] {
  return rects.map(([x, y, width, height]) => ({ left: x / 65535, top: y / 65535, right: (x + width) / 65535, bottom: (y + height) / 65535 }));
}

function unionBounds(bounds: NativeBounds[]): NativeBounds | undefined {
  if (bounds.length === 0) return;
  return {
    left: Math.min(...bounds.map(bound => bound.left)),
    top: Math.min(...bounds.map(bound => bound.top)),
    right: Math.max(...bounds.map(bound => bound.right)),
    bottom: Math.max(...bounds.map(bound => bound.bottom)),
  };
}

function referenceForNumber(
  analysis: PaperPreprocessingResult | null,
  number: number,
) {
  return analysis?.references.find(reference => reference.number === number);
}

function citationPreview(
  link: NativeLink & { synthetic?: boolean },
  analysis: PaperPreprocessingResult | null,
) {
  if (!link.synthetic || link.target.kind !== 'internal' || !analysis) {
    return linkPreviewText(link);
  }
  const target = link.target;
  const targetY = target.yFraction ?? 0;
  const reference = analysis.references
    .filter(candidate => candidate.page === target.page)
    .sort(
      (left, right) =>
        Math.abs((left.yFraction ?? 0) - targetY) -
        Math.abs((right.yFraction ?? 0) - targetY),
    )[0];
  return reference
    ? { title: `Reference [${reference.number}]`, detail: reference.text }
    : linkPreviewText(link);
}

// A host's actions on the selected passage, its menu mode and marks: ui/SelectionMenu.tsx.
export type { ReaderFollowUp, ReaderMark, ReaderMarkMenu, ReaderPassage, ReaderSelectionAction, ReaderSelectionActions, ReaderSelectionMode } from '../ui/SelectionMenu';

interface PdfJsBenchmarkAppProps {
  initialFile?: File;
  embedded?: boolean;
  paneTitle?: string;
  keyboardShortcuts?: boolean;
  initialViewState?: PdfJsViewState;
  onViewStateChange?: (state: PdfJsViewState) => void;
  onReady?: () => void;
  onDocumentIdentity?: (hash: string) => void;
  searchTarget?: { id: string; documentHash: string; page: number; rects: number[][]; targetText: string };
  rasterMode?: 'active' | 'parsed';
  visibilityMode?: 'visible' | 'standby' | 'parsed';
  previewUrl?: string;
  onPreviewChange?: (preview: PdfJsPreview) => void;
  onChromeStateChange?: (state: PdfReaderChromeState) => void;
  initialControlState?: { searchQuery: string };
  onRequestControlMode?: (mode: 'search' | 'comments' | null) => void;
  /** When set, the selection toolbar sends the passage to the source's note instead of a comment. */
  onAddToNote?: (passage: { text: string; page: number; color?: string }) => void;
  /** When set, the selection toolbar offers Cite: the host copies the passage as a quote that
   * links back here. `rects` are on the passage's first page, [x, y, width, height] in 0–65535. */
  onCite?: (passage: { text: string; page: number; rects: number[][]; color?: string }) => void;
  /** Extra actions on the selection toolbar, given by the host (a systematic review's "Does not
   * meet…", "Use for field…"). The passage is as for Cite: page 0-based, rects 0–65535. */
  selectionActions?: ReaderSelectionActions;
  /** With it, the host's actions are the selection menu (a review's screening or extraction). */
  selectionMode?: ReaderSelectionMode;
  /** The host's marks in the page (not the user's highlights); a click opens `markActions`. */
  marks?: ReaderMark[];
  markActions?: (mark: ReaderMark) => ReaderMarkMenu | null;
  /** A host's marks also kept as real highlights of this document (the user's own, in the
   *  library) while `enabled`: one per mark, ids under `scope`, the mark's label (+ `note`) as
   *  the comment; they follow the marks (changed, removed or taken back with them), and all of
   *  the scope's go when it is turned off. Other scopes' are left alone. */
  /** `link`: where the marks come from (a review and record), kept on each mirrored highlight
   *  as `reviewLink` so the library's reader can open the review there. */
  mirrorMarks?: { scope: string; note: string; enabled: boolean; marks: ReaderMark[]; link?: Record<string, unknown> } | null;
  /** Where this document's highlights live when the host knows better than the reader (a
   *  library copy opened inside another view): load and save them there. */
  annotationStore?: { load(): Promise<ReaderAnnotation[]>; save(annotations: ReaderAnnotation[], deleted: string[]): Promise<void> } | null;
  /** While set, the next finished selection goes straight here, with no menu (a field's "pick"). */
  pickSelection?: ((passage: ReaderPassage) => void) | null;
  /** Opens a cited work in the library when the host has it there (the citation card's action). */
  referenceInLibrary?: (number: number) => (() => void) | null | undefined;
  /** Lets the citation cards add a cited work to the library in one click. */
  libraryWorks?: LibraryWorks;
  /** Where a highlight is used (notes quoting it, canvases holding it), for its info card. */
  highlightUsage?: (annotation: { id: string; text: string; page: number; reviewLink?: Record<string, unknown> }) => Promise<HighlightUsage[]>;
  /** Height of a toolbar floating over the top of the document: pages start below it. */
  topInset?: number;
  /** References kept by the host's library; when given they replace the reader's own analysis. */
  references?: Array<{ number: number; page: number; xFraction?: number; yFraction?: number; text: string }>;
  /** Shown at the top of the References panel (e.g. the library's analysis status). */
  referencesHeader?: ReactNode;
  /** Extra details under a reference (e.g. what it resolved to, a link into the library). */
  referenceAside?: (reference: { number: number; page: number; text: string }) => ReactNode;
  /** Draws the structure rail along the viewer's edge from the document's outline, pages and marks. */
  renderRail?: (rail: PdfReaderRail) => ReactNode;
}

/** A heading of the document outline; `top` is the fraction down its page where it starts. */
export interface PdfReaderRailSection {
  title: string;
  page: number;
  depth: number;
  top: number;
}

/** A page carrying a highlight or a search hit; `rgb` is the highlight's document colour. */
export interface PdfReaderRailMark {
  page: number;
  kind: 'highlight' | 'search';
  rgb?: string;
  active?: boolean;
}

/** Where the reading line sits: a page index and the fraction down that page. */
export interface PdfReaderRailPosition {
  page: number;
  offset: number;
  /** Scrolled to the bottom, where the last headings can never reach the reading line. */
  end: boolean;
}

export interface PdfReaderRail {
  pageCount: number;
  sections: PdfReaderRailSection[];
  marks: PdfReaderRailMark[];
  /** The current position; changes on scroll without re-rendering the reader. */
  position(): PdfReaderRailPosition;
  subscribe(listener: () => void): () => void;
  goTo(page: number, top?: number): void;
  /** A small rendering of the page as a data URL, cached per document. */
  preview(page: number): Promise<string | null>;
  openOutline(): void;
}

export type PdfReaderPanel = ReaderPanel;

export interface PdfReaderChromeState {
  ready: boolean;
  title: string;
  zoom: number;
  pageCount: number;
  status: string;
  searchQuery: string;
  searchCount: number;
  activeSearchIndex: number;
  searchResults: Array<{ id: string; page: number; preview: string }>;
  searching: boolean;
  activePanel: PdfReaderPanel | null;
  commentCount: number;
  comments: Array<{
    id: string;
    page: number;
    text: string;
    comment: string;
    color: HighlightColor;
    accentRgb: string;
  }>;
  activeCommentId: string | null;
  outlineCount: number;
  referenceCount: number;
}

export interface PdfReaderHandle {
  zoomIn(): void;
  zoomOut(): void;
  actualSize(): void;
  fitWidth(): void;
  setSearchQuery(query: string): void;
  previousSearchResult(): void;
  nextSearchResult(): void;
  activateSearchResult(index: number): void;
  activateComment(id: string): void;
  /** Brings an annotation (or a quoted passage on `page`) to the middle of the view, zoomed
   * to read, and lights it up briefly; `page` when the annotation is not known. */
  focusAnnotation(id: string | undefined, page?: number, quote?: string): void;
  /** Brings a host mark into view and lights it up; false when it is not here. */
  showMark(id: string): boolean;
  closeSearch(): void;
  togglePanel(panel: PdfReaderPanel): void;
  closePanel(): void;
  /** Scrolls `page` into view with `top` (a fraction down it) at the top. */
  goTo(page: number, top?: number): void;
  /** Reading mode: a page region drawn as an image (`rect` [x, y, width, height] in 0–65535). */
  renderRegion(page: number, rect: number[], width: number): Promise<string | null>;
  /** Reading mode: a highlight on a text range the host located; its id. */
  addHighlightAt(range: TextRange, text: string, color: HighlightColor, comment?: string): string | undefined;
  /** Reading mode: a highlight's colour or comment changed; false when it is not here. */
  updateAnnotation(id: string, patch: { color?: HighlightColor; comment?: string }): boolean;
  removeAnnotation(id: string): boolean;
}

const PdfJsBenchmarkApp = forwardRef<PdfReaderHandle, PdfJsBenchmarkAppProps>(
function PdfJsBenchmarkApp({
  initialFile,
  onDocumentIdentity,
  searchTarget,
  embedded = false,
  paneTitle = 'PDF.js reader',
  keyboardShortcuts = true,
  initialViewState,
  onViewStateChange,
  onReady,
  rasterMode = 'active',
  visibilityMode = 'visible',
  previewUrl,
  onPreviewChange,
  onChromeStateChange,
  initialControlState,
  onRequestControlMode,
  onAddToNote,
  onCite,
  selectionActions,
  selectionMode,
  marks: hostMarks,
  markActions,
  mirrorMarks,
  annotationStore,
  pickSelection,
  referenceInLibrary,
  libraryWorks,
  highlightUsage,
  topInset = 0,
  referencesHeader,
  referenceAside,
  references: libraryReferences,
  renderRail,
}: PdfJsBenchmarkAppProps = {}, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<PdfJsTileController | null>(null);
  const overlayRef = useRef<PdfJsTextOverlayManager | null>(null);
  const companionWatchRef = useRef<(() => void) | null>(null);
  const documentIdRef = useRef<string | null>(null);
  const [readerIdentity, setReaderIdentity] = useState<string | null>(null);
  const searchRevisionRef = useRef(0);
  const fixtureRequestedRef = useRef(false);
  const autoRunBenchmarkRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const citationUiId = useId().replaceAll(':', '');
  const [status, setStatus] = useState('Choose a PDF');
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const loadMsRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const loadingTaskRef = useRef<ReturnType<typeof getDocument> | null>(null);
  const [zoom, setZoom] = useState(1);
  const [annotations, setAnnotations] = useState<ReaderAnnotation[]>([]);
  const annotationSnapshotRef = useRef<ReaderAnnotation[]>([]);
  const deletedAnnotationsRef = useRef(new Set<string>());
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  const [activeAnnotation, setActiveAnnotation] = useState<ReaderAnnotation | null>(null);
  // A highlight that was clicked shows its info card; one just made keeps the small toolbar.
  const [annotationInfo, setAnnotationInfo] = useState(false);
  const [contextRect, setContextRect] = useState<DOMRect | null>(null);
  /** A host mark that was clicked: the host's menu for it. */
  const [markMenu, setMarkMenu] = useState<{ mark: ReaderMark; rect: DOMRect; menu: ReaderMarkMenu } | null>(null);
  const markActionsRef = useRef(markActions);
  markActionsRef.current = markActions;
  const hostMarksRef = useRef(hostMarks);
  hostMarksRef.current = hostMarks;
  const selectedPassageRef = useRef<() => ReaderPassage | null>(() => null);
  const annotationStoreRef = useRef(annotationStore);
  annotationStoreRef.current = annotationStore;
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentEditorExpanded, setCommentEditorExpanded] = useState(false);
  const [commentAnchorRect, setCommentAnchorRect] = useState<DOMRect | null>(null);
  const [commentError, setCommentError] = useState('');
  const [activePanel, setActivePanel] = useState<ReaderPanel | null>(null);
  const [analysis, setAnalysis] = useState<PaperPreprocessingResult | null>(null);
  const [hoveredLink, setHoveredLink] = useState<HoveredLink | null>(null);
  const [hoveredCitation, setHoveredCitation] = useState<CitationFocus | null>(null);
  const linkHoverBridgeRef = useRef<HoverCardBridge | null>(null);
  linkHoverBridgeRef.current ??= new HoverCardBridge();
  const [selectedCitation, setSelectedCitation] = useState<CitationFocus | null>(null);
  const [externalCitation, setExternalCitation] =
    useState<ExternalCitationFocus | null>(null);
  const [externalCitationExpanded, setExternalCitationExpanded] = useState(false);
  const externalCitationRequestRef = useRef(0);
  const [activeCitationNumber, setActiveCitationNumber] = useState<number | null>(
    null,
  );
  const [expandedCitationNumber, setExpandedCitationNumber] = useState<
    number | null
  >(null);
  const [scholarly, setScholarly] = useState<Map<number, ScholarlyEntry>>(
    () => new Map(),
  );
  const [searchQuery, setSearchQuery] = useState(
    () => initialControlState?.searchQuery ?? '',
  );
  const [searchMatches, setSearchMatches] = useState<ReaderSearchMatch[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const sourceBytesRef = useRef(0);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const railPositionRef = useRef<PdfReaderRailPosition>({ page: 0, offset: 0, end: false });
  const railListenersRef = useRef(new Set<() => void>());
  const onReadyRef = useRef(onReady);
  const onPreviewChangeRef = useRef(onPreviewChange);
  const onChromeStateChangeRef = useRef(onChromeStateChange);
  const onRequestControlModeRef = useRef(onRequestControlMode);
  const initialViewStateRef = useRef(initialViewState);
  const initialControlStateRef = useRef(initialControlState);
  const lastViewStateRef = useRef<PdfJsViewState | null>(
    initialViewStateRef.current ?? null,
  );
  const visibilityModeRef = useRef(visibilityMode);
  const topInsetRef = useRef(topInset);
  topInsetRef.current = topInset;
  useEffect(() => controllerRef.current?.setTopInset(topInset), [topInset]);
  if (initialViewState) initialViewStateRef.current = initialViewState;
  onViewStateChangeRef.current = onViewStateChange;
  onReadyRef.current = onReady;
  onPreviewChangeRef.current = onPreviewChange;
  onChromeStateChangeRef.current = onChromeStateChange;
  onRequestControlModeRef.current = onRequestControlMode;

  const cancelLinkHoverExit = useCallback(() => {
    linkHoverBridgeRef.current?.cancel();
  }, []);
  const showHoveredLink = useCallback((focus: HoveredLink) => {
    cancelLinkHoverExit();
    setHoveredLink(focus);
  }, [cancelLinkHoverExit]);
  const scheduleLinkHoverExit = useCallback(() => {
    linkHoverBridgeRef.current?.schedule(() => {
      setHoveredLink(null);
    });
  }, []);

  const citationHoverBridgeRef = useRef<HoverCardBridge | null>(null);
  citationHoverBridgeRef.current ??= new HoverCardBridge();
  const showHoveredCitation = useCallback((focus: CitationFocus) => {
    citationHoverBridgeRef.current?.cancel();
    setHoveredCitation(current => (current?.citation.id === focus.citation.id ? current : focus));
  }, []);
  /** Leaving a citation hides its card after a beat, unless the pointer moved onto the card. */
  // Where the pointer last was: a hover ends only once it has left both the citation and its
  // card (re-rendered layers under a still pointer report leaves that are not).
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const track = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('pointermove', track, { capture: true, passive: true });
    return () => window.removeEventListener('pointermove', track, { capture: true });
  }, []);
  const citationAnchorRef = useRef<() => DOMRect | undefined>(() => undefined);
  const scheduleCitationHoverExit = useCallback(() => {
    citationHoverBridgeRef.current?.schedule(() => {
      const pointer = pointerRef.current;
      const over = (rect?: DOMRect | null) =>
        !!rect &&
        !!pointer &&
        pointer.x >= rect.left - 2 &&
        pointer.x <= rect.right + 2 &&
        pointer.y >= rect.top - 2 &&
        pointer.y <= rect.bottom + 2;
      const card = document.querySelector('.pdfjs-cite-card')?.getBoundingClientRect();
      if (over(citationAnchorRef.current()) || over(card)) return;
      setHoveredCitation(null);
    });
  }, []);
  const cancelCitationHoverExit = useCallback(() => citationHoverBridgeRef.current?.cancel(), []);
  const resolveScholarly = useCallback((number: number, metadata: ScholarlyMetadata) => {
    setScholarly(current => {
      if (current.get(number)?.state === 'ready') return current;
      const next = new Map(current);
      next.set(number, { state: 'ready', metadata });
      return next;
    });
  }, []);
  const resolveExternal = useCallback((metadata: ScholarlyMetadata | null) => {
    setExternalCitation(current =>
      current && metadata && current.entry.state !== 'ready'
        ? { ...current, entry: { state: 'ready', metadata } }
        : current,
    );
  }, []);

  useEffect(
    () => () => {
      ++loadGenerationRef.current;
      const pendingTask = loadingTaskRef.current;
      loadingTaskRef.current = null;
      linkHoverBridgeRef.current?.dispose();
      citationHoverBridgeRef.current?.dispose();
      if (lastViewStateRef.current) {
        onViewStateChangeRef.current?.(lastViewStateRef.current);
      }
      overlayRef.current?.destroy();
      overlayRef.current = null;
      companionWatchRef.current?.();
      companionWatchRef.current = null;
      const controller = controllerRef.current;
      controllerRef.current = null;
      const documentId = documentIdRef.current;
      documentIdRef.current = null;
      pdfJsDestructionBarrier = pdfJsDestructionBarrier
        .catch(() => undefined)
        .then(async () => {
          if (controller) await controller.destroy();
          else await pendingTask?.destroy();
          if (documentId) await closeNativeCompanion(documentId);
        });
    },
    [cancelLinkHoverExit],
  );

  const load = useCallback(async (file: File) => {
    const generation = ++loadGenerationRef.current;
    await pdfJsDestructionBarrier.catch(() => undefined);
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content || generation !== loadGenerationRef.current) return;
    setReady(false);
    setAnalysis(null);
    cancelLinkHoverExit();
    setHoveredLink(null);
    setHoveredCitation(null);
    setSelectedCitation(null);
    setExternalCitation(null);
    setExternalCitationExpanded(false);
    externalCitationRequestRef.current += 1;
    setActiveCitationNumber(null);
    setExpandedCitationNumber(null);
    setScholarly(new Map());
    setStatus('PDF.js: loading document');
    window.__PDFJS_READY__ = false;
    window.__PDFJS_FEATURES_READY__ = false;
    window.__PDFJS_ERROR__ = undefined;
    window.__PDFJS_BENCHMARK_RESULT__ = undefined;
    overlayRef.current?.destroy();
    overlayRef.current = null;
    companionWatchRef.current?.();
    companionWatchRef.current = null;
    if (controllerRef.current) await controllerRef.current.destroy();
    else await loadingTaskRef.current?.destroy();
    if (documentIdRef.current) await closeNativeCompanion(documentIdRef.current);
    documentIdRef.current = null;
    content.replaceChildren();
    const start = performance.now();
    try {
      if (generation !== loadGenerationRef.current) return;
      const managed = managedSourceFor(file);
      sourceBytesRef.current = managed?.size ?? file.size;
      const companionPromise = openNativeCompanion(file, undefined, false).then(companion => {
        if (generation !== loadGenerationRef.current) void closeNativeCompanion(companion.id);
        return companion;
      });
      // Attach a handler immediately: painting and import proceed independently.
      void companionPromise.catch(() => undefined);
      let objectUrl: string | undefined;
      const transport = managed ? new ManagedPdfTransport(managed, error => {
        setStatus(`PDF source read failed: ${String(error)}`);
        window.__PDFJS_ERROR__ = String(error);
        void loadingTask.destroy();
      }) : undefined;
      const loadingTask = transport
        ? getDocument({ range: transport, rangeChunkSize: 256 * 1024, disableAutoFetch: true, disableStream: true })
        : getDocument({ url: (objectUrl = URL.createObjectURL(file)) });
      loadingTaskRef.current = loadingTask;
      let documentProxy;
      try { documentProxy = await loadingTask.promise; }
      finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
      if (generation !== loadGenerationRef.current) return;
      const firstPage = await documentProxy.getPage(1);
      if (generation !== loadGenerationRef.current) return;
      const firstViewport = firstPage.getViewport({ scale: 1 });
      const sourcePages = Array.from({ length: documentProxy.numPages }, () => ({ page: firstPage, width: firstViewport.width, height: firstViewport.height }));
      const controller = new PdfJsTileController(
        scroll,
        content,
        documentProxy,
        sourcePages,
        embedded ? 16 * 1024 * 1024 : undefined,
      );
      controllerRef.current = controller;
      controller.setTopInset(topInsetRef.current);
      controller.onZoomChange(setZoom);
      if (initialViewStateRef.current) {
        controller.restoreViewState(initialViewStateRef.current);
      }
      controller.onViewStateChange(state => {
        // WebKit emits a synthetic scrollTop=0 event when an existing reader
        // moves behind the visible pane. The state captured while visible is
        // authoritative; hidden layout activity must not overwrite it.
        if (
          visibilityModeRef.current !== 'visible' &&
          lastViewStateRef.current
        ) {
          return;
        }
        initialViewStateRef.current = state;
        lastViewStateRef.current = state;
        onViewStateChangeRef.current?.(state);
        const position = railPositionRef.current;
        const end = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
        if (
          position.page !== state.pageIndex ||
          position.offset !== state.pageOffsetFraction ||
          position.end !== end
        ) {
          railPositionRef.current = { page: state.pageIndex, offset: state.pageOffsetFraction, end };
          railListenersRef.current.forEach(listener => listener());
        }
      });
      controller.onPreviewChange(preview => {
        onPreviewChangeRef.current?.(preview);
      });
      setReady(true);
      const companion = await companionPromise;
      if (generation !== loadGenerationRef.current) return;
      setAnalysis(companion.analysis ?? null);
      setScholarly(preprocessedScholarlyEntries(companion.analysis));
      documentIdRef.current = companion.id;
      onDocumentIdentity?.(companion.id);
      const overlay = new PdfJsTextOverlayManager(companion.id, controller.pageHosts());
      overlayRef.current = overlay;
      setReaderIdentity(companion.id);
      overlay.setLinks(
        companion.analysis?.document.links ?? companion.document?.links ?? [],
      );
      overlay.setCitations(companion.analysis?.citations ?? []);
      companionWatchRef.current = watchNativeCompanion(
        companion.id,
        snapshot => {
          if (documentIdRef.current !== companion.id) return;
          if (snapshot.analysis) {
            setAnalysis(snapshot.analysis);
            setScholarly(preprocessedScholarlyEntries(snapshot.analysis));
            overlayRef.current?.setLinks(snapshot.analysis.document.links);
            overlayRef.current?.setCitations(snapshot.analysis.citations ?? []);
          }
          if (snapshot.stage === 'failed' && snapshot.error) {
            setStatus(`Reader ready · analysis unavailable: ${snapshot.error}`);
          }
        },
      );
      const restored = annotationStoreRef.current ? await annotationStoreRef.current.load().catch(() => loadCanonicalAnnotations(companion.id)) : await loadCanonicalAnnotations(companion.id);
      if (generation !== loadGenerationRef.current) return;
      setAnnotations(restored);
      annotationSnapshotRef.current = restored;
      deletedAnnotationsRef.current.clear();
      overlay.setAnnotations(restored);
      overlay.onSelection(snapshot => {
        setSelection(snapshot);
        setContextRect(snapshot?.viewportRect ?? null);
        if (snapshot) setActiveAnnotation(null);
      });
      overlay.onHostMarkActivation((found, rect) => {
        const mark = hostMarksRef.current?.find(m => m.id === found.id);
        const menu = mark && markActionsRef.current?.(mark);
        setSelection(null);
        setActiveAnnotation(null);
        setContextRect(null);
        setMarkMenu(mark && menu ? { mark, rect, menu } : null);
      });
      overlay.onAnnotationActivation((annotation, rect) => {
        setSelection(null);
        setActiveAnnotation(annotation);
        setAnnotationInfo(true);
        setContextRect(rect ?? null);
      });
      overlay.onLinkActivation((link, rect) => {
        if (link.target.kind === 'internal') {
          controller.scrollToBounds(link.target.page, {
            left: link.target.xFraction ?? 0,
            right: link.target.xFraction ?? 0,
            top: link.target.yFraction ?? 0,
            bottom: link.target.yFraction ?? 0,
          });
        } else if (isScholarlyResourceUrl(link.target.url) && isTauri()) {
          ++externalCitationRequestRef.current;
          cancelLinkHoverExit();
          setHoveredLink(null);
          setHoveredCitation(null);
          setSelectedCitation(null);
          setExternalCitationExpanded(false);
          // The card looks the work up (and retries while a provider is rate limited).
          setExternalCitation({ link, rect, entry: { state: 'loading' } });
          setActivePanel(null);
        } else {
          window.open(link.target.url, '_blank', 'noopener,noreferrer');
        }
      });
      overlay.onLinkHover((link, rect) => {
        if (link && rect) {
          showHoveredLink({ link, rect });
        } else {
          scheduleLinkHoverExit();
        }
      });
      overlay.onCitationActivation((citation, rect) => {
        cancelLinkHoverExit();
        setHoveredLink(null);
        setHoveredCitation(null);
        setExternalCitation(null);
        setExternalCitationExpanded(false);
        setSelectedCitation({ citation, rect });
        setActiveCitationNumber(citation.numbers[0] ?? null);
        setActivePanel(null);
      });
      overlay.onCitationHover((citation, rect) => {
        if (citation && rect) {
          cancelLinkHoverExit();
          setHoveredLink(null);
          showHoveredCitation({ citation, rect });
        } else {
          scheduleCitationHoverExit();
        }
      });
      controller.onVisiblePages(pages => {
        const demand = pages.flatMap(page => [page - 1, page, page + 1]);
        void overlay.ensurePages(
          demand.filter(page => page >= 0 && page < documentProxy.numPages),
        );
      });
      // A slow first raster is a performance result, not a load failure. Tiles
      // keep streaming in either way, so treating the timeout as fatal only
      // stranded a perfectly readable document behind the blur veil.
      const settled = await controller.waitForExact();
      await overlay.ensurePage(0);
      if (generation !== loadGenerationRef.current) return;
      const duration = performance.now() - start;
      loadMsRef.current = duration;
      setZoom(controller.currentZoom());
      setSelection(null);
      setActiveAnnotation(null);
      setCommentDraft(null);
      setCommentAnchorRect(null);
      setCommentEditorExpanded(false);
      setActivePanel(null);
      setSearchQuery(initialControlStateRef.current?.searchQuery ?? '');
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      setReady(true);
      setStatus(
        settled.timedOut
          ? `Ready · ${documentProxy.numPages} pages · still rasterising`
          : `Ready · ${documentProxy.numPages} pages · rendering + text ${Math.round(duration)} ms`,
      );
      window.__PDFJS_READY__ = true;
      window.__PDFJS_FEATURES_READY__ = true;
      onReadyRef.current?.();
      if (isTauri()) void invoke('benchmark_phase', { name: 'load-ready' });
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      window.__PDFJS_ERROR__ = message;
      setStatus(`PDF.js failed: ${message}`);
      if (isTauri()) {
        void invoke('benchmark_report', {
          payload: {
            error: `reader load failed: ${message}${
              error instanceof Error && error.stack ? `\n${error.stack}` : ''
            }`,
          },
        }).catch(() => undefined);
      }
    }
  }, [
    cancelLinkHoverExit,
    embedded,
    scheduleCitationHoverExit,
    scheduleLinkHoverExit,
    showHoveredCitation,
    showHoveredLink,
  ]);

  useLayoutEffect(() => {
    const previousMode = visibilityModeRef.current;
    visibilityModeRef.current = visibilityMode;
    const controller = controllerRef.current;
    if (!ready || !controller || previousMode === visibilityMode) return;

    const persisted = initialViewStateRef.current ?? lastViewStateRef.current;
    if (visibilityMode === 'visible' && persisted) {
      controller.restoreViewState(persisted);
      const restored = controller.currentViewState();
      initialViewStateRef.current = restored;
      lastViewStateRef.current = restored;
      onViewStateChangeRef.current?.(restored);
    }
  }, [ready, visibilityMode]);

  // Panels remain true overlays. The controller adds trailing scroll range
  // while keeping the page centred against the unchanged viewport, so the
  // user can move the full page out from underneath an open panel.
  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (!activePanel) {
      controller?.setPanelInset(0);
      return;
    }
    const panel = scrollRef.current?.parentElement?.querySelector<HTMLElement>(
      '.key-panel-shell, .key-side-panel',
    );
    if (!panel) {
      controller?.setPanelInset(0);
      return;
    }
    const update = () => {
      const panelRect = panel.getBoundingClientRect();
      controller?.setPanelInset(panelRect.width + PANEL_EDGE_GAP * 2);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      controller?.setPanelInset(0);
    };
  }, [activePanel, ready]);

  const citationFocus = selectedCitation ?? hoveredCitation;
  const selectedCitationNumbers = citationFocus?.citation.numbers ?? [];
  const selectedActiveCitationNumber =
    activeCitationNumber !== null &&
    selectedCitationNumbers.includes(activeCitationNumber)
      ? activeCitationNumber
      : selectedCitationNumbers[0] ?? null;
  const resolveHoveredLinkAnchor = useCallback(
    () =>
      hoveredLink
        ? overlayRef.current?.viewportRectForPageBounds(hoveredLink.link.page, [
            hoveredLink.link.bounds,
          ]) ?? hoveredLink.rect
        : undefined,
    [hoveredLink],
  );
  const resolveCitationAnchor = useCallback(
    () =>
      citationFocus
        ? overlayRef.current?.viewportRectForPageBounds(
            citationFocus.citation.page,
            [citationFocus.citation.bounds],
          ) ?? citationFocus.rect
        : undefined,
    [citationFocus],
  );
  citationAnchorRef.current = resolveCitationAnchor;
  const resolveExternalCitationAnchor = useCallback(
    () =>
      externalCitation
        ? overlayRef.current?.viewportRectForPageBounds(
            externalCitation.link.page,
            [externalCitation.link.bounds],
          ) ?? externalCitation.rect
        : undefined,
    [externalCitation],
  );

  useEffect(() => {
    const numbers = citationFocus?.citation.numbers ?? [];
    setActiveCitationNumber(current =>
      current !== null && numbers.includes(current)
        ? current
        : numbers[0] ?? null,
    );
    setExpandedCitationNumber(null);
  }, [citationFocus?.citation.id]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const overlay = overlayRef.current;
    const range =
      commentDraft?.range ?? selection?.range ?? activeAnnotation?.range;
    if (!scroll || !overlay || !range) return;
    let frame = 0;
    let gone = false;
    const update = () => {
      if (frame || gone) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = overlay.viewportRectForRange(range);
        if (commentDraft) return setCommentAnchorRect(rect ?? null);
        // Scrolled out of view: the toolbar goes, and stays gone until the next selection.
        const view = scroll.getBoundingClientRect();
        if (!rect || rect.bottom < view.top + topInset || rect.top > view.bottom || rect.right < view.left || rect.left > view.right) {
          gone = true;
          setContextRect(null);
          return;
        }
        setContextRect(rect);
      });
    };
    scroll.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    return () => {
      scroll.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [activeAnnotation, commentDraft, selection, topInset]);

  useEffect(() => {
    if (isTauri() && ready && readerIdentity && visibilityMode === 'visible') {
      void invoke('library_prioritize', { hash: readerIdentity }).catch(() => undefined);
    }
  }, [ready, readerIdentity, visibilityMode]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!ready || !controller) return;
    if (rasterMode === 'parsed') {
      controller.suspendRaster(false);
      if (documentIdRef.current) {
        releaseNativeCompanionText(documentIdRef.current);
      }
    }
    else controller.resumeRaster();
  }, [rasterMode, ready]);

  const initialFileRef = useRef<File | null>(null);
  useEffect(() => {
    if (!initialFile || initialFileRef.current === initialFile) return;
    initialFileRef.current = initialFile;
    void load(initialFile);
  }, [initialFile, load]);

  useEffect(() => {
    if (initialFile || !isTauri() || fixtureRequestedRef.current) return;
    fixtureRequestedRef.current = true;
    void invoke<BenchmarkFixture | null>('benchmark_fixture')
      .then(async fixture => {
        if (!fixture) return;
        await invoke('benchmark_phase', { name: 'baseline-ready' });
        await new Promise(resolve => window.setTimeout(resolve, 600));
        await invoke('benchmark_phase', { name: 'load-start' });
        autoRunBenchmarkRef.current = true;
        await load(
          new File([Uint8Array.from(fixture.bytes)], fixture.name, {
            type: 'application/pdf',
            lastModified: 0,
          }),
        );
      })
      .catch(error => setStatus(`Benchmark fixture failed: ${String(error)}`));
  }, [initialFile, load]);

  const updateAnnotations = useCallback((next: ReaderAnnotation[]) => {
    const documentId = documentIdRef.current;
    if (!documentId) return;
    next = next.map(annotation => {
      if (annotation.anchor) return annotation;
      const pages: Array<{ page: number; bounds: NativeBounds[] }> = [];
      for (let page = annotation.range.start.page; page <= annotation.range.end.page; page += 1) {
        const text = overlayRef.current?.textPages.get(page);
        if (!text) return annotation;
        pages.push({ page, bounds: boundsForRange(text, annotation.range) });
      }
      return { ...annotation, anchor: { version: 1 as const, pages } };
    });
    const nextIds = new Set(next.map(a => a.id));
    for (const a of annotationSnapshotRef.current) if (!nextIds.has(a.id)) deletedAnnotationsRef.current.add(a.id);
    for (const id of nextIds) deletedAnnotationsRef.current.delete(id);
    annotationSnapshotRef.current = next;
    setAnnotations(next);
    setStatus('Saving annotation…');
    const store = annotationStoreRef.current;
    void (store ? store.save(next, [...deletedAnnotationsRef.current]) : saveCanonicalAnnotations(documentId, next, [...deletedAnnotationsRef.current])).then(() => { if (documentIdRef.current === documentId) setStatus('Annotation saved'); }).catch(error => { if (documentIdRef.current === documentId) setStatus(`Annotation not saved: ${String(error)}`); });
    overlayRef.current?.setAnnotations(next);
  }, []);

  const addHighlight = useCallback(
    (color: HighlightColor) => {
      const documentId = documentIdRef.current;
      if (!documentId) return;
      const range = selection?.range ?? activeAnnotation?.range;
      if (!range) return;
      const exact = annotations.find(
        annotation =>
          annotation.range.start.page === range.start.page &&
          annotation.range.start.index === range.start.index &&
          annotation.range.end.page === range.end.page &&
          annotation.range.end.index === range.end.index,
      );
      const now = new Date().toISOString();
      const updated: ReaderAnnotation = exact
        ? { ...exact, color, updatedAt: now }
        : {
            id: annotationId(),
            documentId,
            range,
            text: selection?.text ?? activeAnnotation?.text ?? '',
            color,
            createdAt: now,
            updatedAt: now,
          };
      updateAnnotations([
        ...annotations.filter(annotation => annotation.id !== updated.id),
        updated,
      ]);
      overlayRef.current?.clearBrowserSelection();
      if (selection) setAnnotationInfo(false);
      setSelection(null);
      setActiveAnnotation(updated);
      requestAnimationFrame(() => {
        setContextRect(
          overlayRef.current?.viewportRectForRange(updated.range) ?? null,
        );
      });
      setStatus(`Added ${color} highlight`);
      return updated;
    },
    [activeAnnotation, annotations, selection, updateAnnotations],
  );

  const openCommentEditor = useCallback(() => {
    const range = selection?.range ?? activeAnnotation?.range;
    if (!range) return;
    setCommentError('');
    setCommentDraft({
      range,
      annotationId: activeAnnotation?.id,
      text: selection?.text ?? activeAnnotation?.text ?? '',
      comment: activeAnnotation?.comment ?? '',
    });
    setCommentAnchorRect(
      contextRect ?? overlayRef.current?.viewportRectForRange(range) ?? null,
    );
    setCommentEditorExpanded(true);
    onRequestControlModeRef.current?.('comments');
  }, [activeAnnotation, contextRect, selection]);

  const openAnnotationEditor = useCallback(
    async (annotation: ReaderAnnotation) => {
      const overlay = overlayRef.current;
      const controller = controllerRef.current;
      const page = annotation.range.start.page;
      await overlay?.ensurePage(page);
      const textPage = overlay?.textPages.get(page);
      const targetBounds = textPage
        ? unionBounds(boundsForRange(textPage, annotation.range))
        : undefined;

      setSelection(null);
      setActiveAnnotation(annotation);
      setContextRect(null);
      setCommentError('');
      setCommentDraft({
        range: annotation.range,
        annotationId: annotation.id,
        text: annotation.text,
        comment: annotation.comment ?? '',
      });
      setCommentEditorExpanded(true);
      setCommentAnchorRect(
        overlay?.viewportRectForRange(annotation.range) ?? null,
      );
      onRequestControlModeRef.current?.('comments');
      controller?.centerOnBounds(page, targetBounds);

      requestAnimationFrame(() => {
        setCommentAnchorRect(
          overlayRef.current?.viewportRectForRange(annotation.range) ?? null,
        );
      });
    },
    [],
  );

  const saveComment = useCallback(() => {
    const documentId = documentIdRef.current;
    if (!documentId || !commentDraft) return;
    const comment = commentDraft.comment.trim();
    if (!comment) {
      setCommentError('A comment cannot be empty.');
      return;
    }
    const now = new Date().toISOString();
    const next = upsertAnnotationComment(annotations, {
      annotationId: commentDraft.annotationId,
      documentId,
      range: commentDraft.range,
      text: commentDraft.text,
      comment,
      timestamp: now,
    });
    const updated = next.find(annotation =>
      commentDraft.annotationId
        ? annotation.id === commentDraft.annotationId
        : annotation.comment === comment &&
          annotation.range.start.page === commentDraft.range.start.page &&
          annotation.range.start.index === commentDraft.range.start.index,
    )!;
    updateAnnotations(next);
    overlayRef.current?.clearBrowserSelection();
    setSelection(null);
    setActiveAnnotation(updated);
    setCommentDraft(null);
    setCommentAnchorRect(null);
    setCommentEditorExpanded(false);
    setStatus('Comment saved');
  }, [annotations, commentDraft, updateAnnotations]);

  // ⌘↩ saves the comment being written (before the app's own shortcuts see it).
  const saveCommentRef = useRef(saveComment);
  saveCommentRef.current = saveComment;
  useEffect(() => {
    if (!commentDraft) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
      if (!(event.target instanceof Element) || !event.target.closest('.pdfjs-comment-anchor-card')) return;
      event.preventDefault();
      event.stopPropagation();
      saveCommentRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [commentDraft]);

  const removeActiveAnnotation = useCallback(() => {
    if (!activeAnnotation) return;
    updateAnnotations(
      annotations.filter(annotation => annotation.id !== activeAnnotation.id),
    );
    setActiveAnnotation(null);
    setContextRect(null);
    setStatus('Annotation removed');
  }, [activeAnnotation, annotations, updateAnnotations]);

  const copyContextText = useCallback(async () => {
    const text = selection?.text ?? activeAnnotation?.text ?? '';
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied selected text');
    } catch {
      setStatus('Could not copy selected text');
    }
  }, [activeAnnotation, selection]);

  /** The passage under the selection toolbar: its text, first page and boxes there. */
  const selectedPassage = useCallback(() => {
    const range = selection?.range ?? activeAnnotation?.range;
    const text = (selection?.text ?? activeAnnotation?.text ?? '').trim();
    if (!range || !text) return null;
    const page = range.start.page;
    const pageText = overlayRef.current?.textPages.get(page);
    const bounds =
      activeAnnotation?.anchor?.pages.find(entry => entry.page === page)?.bounds ??
      (pageText ? boundsForRange(pageText, range) : []);
    const unit = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 65535);
    return {
      text,
      page,
      rects: bounds.map(bound => [
        unit(bound.left),
        unit(bound.top),
        unit(bound.right - bound.left),
        unit(bound.bottom - bound.top),
      ]),
    };
  }, [activeAnnotation, selection]);

  selectedPassageRef.current = selectedPassage;

  /** Cite: the passage, copied as a quote by the host. */
  const citeContext = useCallback(() => {
    if (!onCite) return;
    const passage = selectedPassage();
    if (!passage) return;
    onCite({ ...passage, color: activeAnnotation?.color });
    setStatus('Quote copied');
  }, [activeAnnotation, onCite, selectedPassage]);

  const activateSearch = useCallback(
    (matches: ReaderSearchMatch[], index: number) => {
      if (matches.length === 0) {
        setActiveSearchIndex(-1);
        overlayRef.current?.setSearch([], null);
        return;
      }
      const normalized = ((index % matches.length) + matches.length) % matches.length;
      const match = matches[normalized];
      setActiveSearchIndex(normalized);
      overlayRef.current?.setSearch(matches, match.id);
      controllerRef.current?.scrollToBounds(match.page, match.bounds[0]);
      void overlayRef.current?.ensurePage(match.page);
    },
    [],
  );

  const runSearch = useCallback(
    async (query: string, navigate = true) => {
      const documentId = documentIdRef.current;
      const overlay = overlayRef.current;
      if (!documentId || !overlay) return [] as ReaderSearchMatch[];
      const trimmed = query.trim();
      const revision = ++searchRevisionRef.current;
      if (!trimmed) {
        setSearchMatches([]);
        setActiveSearchIndex(-1);
        overlay.setSearch([], null);
        return [];
      }
      setSearching(true);
      try {
        const matches = isTauri() && hasNativeCompanionText(documentId)
          ? await searchReaderDocument(documentId, trimmed, overlay.textPages)
          : await overlay.search(trimmed, () => revision !== searchRevisionRef.current);
        if (revision !== searchRevisionRef.current) return [];
        setSearchMatches(matches);
        if (navigate) activateSearch(matches, 0);
        else overlay.setSearch(matches, matches[0]?.id ?? null);
        return matches;
      } catch (error) {
        if (revision === searchRevisionRef.current) {
          setStatus(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return [];
      } finally {
        if (revision === searchRevisionRef.current) setSearching(false);
      }
    },
    [activateSearch],
  );

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void runSearch(searchQuery), 180);
    return () => window.clearTimeout(timer);
  }, [ready, runSearch, searchQuery]);

  useEffect(() => {
    if (!keyboardShortcuts) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.matches('input, textarea, select') ||
        target?.isContentEditable;
      const command = event.metaKey || event.ctrlKey;
      const applyZoom = (next: number) => {
        controllerRef.current?.setZoom(next);
        setZoom(controllerRef.current?.currentZoom() ?? next);
      };
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault();
        onRequestControlModeRef.current?.('search');
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (command && event.key.toLocaleLowerCase() === 'c' && selection && !editing) {
        event.preventDefault();
        void copyContextText();
        return;
      }
      if (command && event.key.toLocaleLowerCase() === 'g') {
        event.preventDefault();
        activateSearch(
          searchMatches,
          activeSearchIndex + (event.shiftKey ? -1 : 1),
        );
        return;
      }
      if (command && event.key === '0') {
        event.preventDefault();
        controllerRef.current?.actualSize();
        setZoom(controllerRef.current?.currentZoom() ?? 1);
        return;
      }
      if (command && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        applyZoom((controllerRef.current?.currentZoom() ?? 1) * 1.2);
        return;
      }
      if (command && event.key === '-') {
        event.preventDefault();
        applyZoom((controllerRef.current?.currentZoom() ?? 1) / 1.2);
        return;
      }
      if (command && event.altKey && event.key.toLocaleLowerCase() === 'm') {
        event.preventDefault();
        openCommentEditor();
        return;
      }
      if (event.key === 'Escape') {
        if (externalCitationExpanded) {
          setExternalCitationExpanded(false);
          return;
        }
        if (expandedCitationNumber !== null) {
          setExpandedCitationNumber(null);
          return;
        }
        overlayRef.current?.clearBrowserSelection();
        setSelection(null);
        setActiveAnnotation(null);
        setContextRect(null);
        setActivePanel(null);
        setSelectedCitation(null);
        setExternalCitation(null);
        setHoveredCitation(null);
        return;
      }
      if (editing) return;
      const controller = controllerRef.current;
      if (!controller) return;
      const pageStep = Math.max(120, (scrollRef.current?.clientHeight ?? 600) * 0.86);
      const actions: Record<string, () => void> = {
        ArrowUp: () => controller.scrollByPixels(0, -48),
        ArrowDown: () => controller.scrollByPixels(0, 48),
        ArrowLeft: () => controller.scrollByPixels(-48, 0),
        ArrowRight: () => controller.scrollByPixels(48, 0),
        PageUp: () => controller.scrollByPixels(0, -pageStep),
        PageDown: () => controller.scrollByPixels(0, pageStep),
        Home: () => controller.scrollToFraction(0),
        End: () => controller.scrollToFraction(1),
        ' ': () => controller.scrollByPixels(0, event.shiftKey ? -pageStep : pageStep),
      };
      const action = actions[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activateSearch,
    activeSearchIndex,
    copyContextText,
    expandedCitationNumber,
    externalCitationExpanded,
    keyboardShortcuts,
    openCommentEditor,
    searchMatches,
    selection,
  ]);

  const benchmark = useCallback(async () => {
    const controller = controllerRef.current;
    const overlay = overlayRef.current;
    if (!controller || !overlay || running) return;
    setRunning(true);
    setStatus('Preparing text, search, and overlays');
    if (isTauri()) void invoke('benchmark_phase', { name: 'feature-start' });
    const featureStart = performance.now();
    const benchmarkMatches = await runSearch('the', false);
    const featureSetupMs = performance.now() - featureStart;
    if (isTauri()) {
      await invoke('benchmark_phase', { name: 'feature-ready' });
      await new Promise(resolve => window.setTimeout(resolve, 150));
    }
    setStatus('Running layered scroll/zoom sequence');
    const intervals: number[] = [];
    const settleTimes: number[] = [];
    let settleTimeouts = 0;
    let collecting = true;
    let previous = performance.now();
    const collect = (now: number) => {
      if (!collecting) return;
      intervals.push(now - previous);
      previous = now;
      requestAnimationFrame(collect);
    };
    requestAnimationFrame(collect);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    if (isTauri()) void invoke('benchmark_phase', { name: 'interaction-start' });
    const settle = async () => {
      await nextFrames(4);
      const result = await controller.waitForExact();
      settleTimes.push(result.durationMs);
      if (result.timedOut) settleTimeouts += 1;
    };
    const scrollTargets = [0, 0.25, 0.5, 1];
    for (const target of scrollTargets) {
      controller.scrollToFraction(target);
      await settle();
    }
    for (const zoom of [1, 1.5, 2, 0.8, 1.25, 1]) {
      controller.setZoom(zoom);
      await settle();
    }
    for (const target of [...scrollTargets].reverse()) {
      controller.scrollToFraction(target);
      await settle();
    }
    await nextFrames(10);
    collecting = false;
    const usable = intervals.slice(1);
    const result: PdfJsBenchmarkResult = {
      schemaVersion: 1,
      renderer: 'pdfjs-canvas-tiles',
      userAgent: navigator.userAgent,
      startedAt,
      pageCount: controller.pageCount(),
      sourceBytes: sourceBytesRef.current,
      loadMs: loadMsRef.current,
      featureSetupMs,
      interactionMs: performance.now() - start,
      frameIntervals: {
        median: percentile(usable, 0.5),
        p95: percentile(usable, 0.95),
        maximum: Math.max(0, ...usable),
        framesOver20Ms: usable.filter(value => value > 20).length,
      },
      exactRenderSettleMs: {
        median: percentile(settleTimes, 0.5),
        p95: percentile(settleTimes, 0.95),
        maximum: Math.max(0, ...settleTimes),
        timeouts: settleTimeouts,
      },
      cache: controller.cacheMetrics(),
      scenario: { scrollJumps: 8, zoomChanges: 6 },
    };
    window.__PDFJS_BENCHMARK_RESULT__ = result;
    if (isTauri()) void invoke('benchmark_report', { payload: result });
    setRunning(false);
    setStatus(
      `Done · ${benchmarkMatches.length} search hits · ${Math.round(result.interactionMs)} ms · p95 ${result.frameIntervals.p95.toFixed(1)} ms`,
    );
  }, [runSearch, running]);

  const setReaderZoom = useCallback((next: number) => {
    controllerRef.current?.setZoom(next);
    setZoom(controllerRef.current?.currentZoom() ?? next);
  }, []);

  const activeAnnotationId = activeAnnotation?.id;
  const annotationUsage = useMemo(() => {
    const annotation = annotations.find(a => a.id === activeAnnotationId);
    if (!highlightUsage || !annotation) return undefined;
    return () => highlightUsage({ id: annotation.id, text: annotation.text, page: annotation.range.start.page, reviewLink: (annotation as { reviewLink?: Record<string, unknown> }).reviewLink });
  }, [activeAnnotationId, highlightUsage]);
  const context = selection || activeAnnotation ? contextRect : null;
  // The menu follows its passage while it scrolls and closes once it leaves the view.
  useReaderOverlay(!!context && !commentDraft, '.ksm, .key-highlight-info', () => setContextRect(null), { scroll: false });
  useReaderOverlay(!!markMenu, '.ksm', () => setMarkMenu(null), { scroll: false });
  // The host's marks, drawn in the pages (again when the reader has its text).
  useEffect(() => {
    overlayRef.current?.setHostMarks((hostMarks ?? []).map(m => ({ id: m.id, page: m.page, bounds: toBounds(m.rects), tone: m.tone, label: m.label })));
  }, [hostMarks, ready, readerIdentity]);
  useEffect(() => {
    if (markMenu && !hostMarks?.some(m => m.id === markMenu.mark.id)) setMarkMenu(null);
  }, [hostMarks, markMenu]);
  // Host marks kept as the user's own highlights (a review's "also keep as my highlights"): one
  // annotation per mark, its id derived from the mark's, placed by the mark's words on its page.
  const mirrorScope = mirrorMarks ? `review-mark:${mirrorMarks.scope}:` : null;
  const mirrorNote = mirrorMarks?.note ?? '';
  const mirrorOn = !!mirrorMarks?.enabled;
  const mirrored = mirrorMarks?.marks;
  const mirrorLink = mirrorMarks?.link ? JSON.stringify(mirrorMarks.link) : '';
  useEffect(() => {
    const overlay = overlayRef.current;
    const documentId = documentIdRef.current;
    if (!ready || !overlay || !documentId || !mirrorScope) return;
    let cancelled = false;
    const tone: Record<string, HighlightColor> = { notMet: 'pink', met: 'green', evidence: 'blue', source: 'purple' };
    const wanted = mirrorOn ? (mirrored ?? []).filter(m => m.page >= 0 && m.text.trim()) : [];
    void (async () => {
      const current = annotationSnapshotRef.current;
      const keep = new Set(wanted.map(m => `${mirrorScope}${m.id}`));
      let next = current.filter(a => !(a.id.startsWith(mirrorScope) && !keep.has(a.id)));
      for (const mark of wanted) {
        const id = `${mirrorScope}${mark.id}`;
        const comment = `${mark.label}${mirrorNote ? ` (${mirrorNote})` : ''}`;
        const color = tone[mark.tone] ?? 'orange';
        const reviewLink = mirrorLink ? { ...JSON.parse(mirrorLink), markId: mark.id, page: mark.page, quote: mark.text.slice(0, 300), label: mark.label } : undefined;
        const have = next.find(a => a.id === id) as (ReaderAnnotation & { reviewLink?: unknown }) | undefined;
        if (have) {
          const linkChanged = !!reviewLink && JSON.stringify(have.reviewLink ?? null) !== JSON.stringify(reviewLink);
          if (have.comment !== comment || have.color !== color || linkChanged) next = next.map(a => (a.id === id ? ({ ...a, comment, color, ...(reviewLink ? { reviewLink } : {}), updatedAt: new Date().toISOString() } as ReaderAnnotation) : a));
          continue;
        }
        await overlay.ensurePage(mark.page).catch(() => undefined);
        if (cancelled) return;
        const page = overlay.textPages.get(mark.page);
        const range = page ? locateQuote(page, mark.text) : null;
        if (!range) continue;
        const now = new Date().toISOString();
        next = [...next, { id, documentId, range, text: mark.text, color, comment, createdAt: now, updatedAt: now, ...(reviewLink ? { reviewLink } : {}) } as ReaderAnnotation];
      }
      if (cancelled) return;
      const same = next.length === current.length && next.every((a, i) => a === current[i]);
      if (!same) updateAnnotations(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, readerIdentity, mirrored, mirrorScope, mirrorNote, mirrorOn, mirrorLink]);
  // A finished selection the host takes (no menu): after the pointer is up.
  const interceptRef = useRef(pickSelection);
  interceptRef.current = pickSelection;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    const up = () =>
      window.setTimeout(() => {
        const take = interceptRef.current;
        if (!take || !selectionRef.current) return;
        const passage = selectedPassageRef.current();
        if (passage) {
          take(passage);
          overlayRef.current?.clearBrowserSelection();
          setSelection(null);
          setContextRect(null);
        }
      }, 0);
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);
  useReaderOverlay(!!hoveredLink && !context, '.pdfjs-link-card', () => setHoveredLink(null));
  // A card the user clicked (or expanded) stays while the page or the card scrolls; one that
  // only follows the pointer goes when the page scrolls away from it.
  useReaderOverlay(!!citationFocus && !context, '.pdfjs-cite-card', () => (setSelectedCitation(null), setHoveredCitation(null), setExpandedCitationNumber(null)), {
    scroll: !selectedCitation && expandedCitationNumber === null,
  });
  useReaderOverlay(!!externalCitation && !context, '.pdfjs-cite-card', () => (setExternalCitation(null), setExternalCitationExpanded(false)), {
    scroll: false,
  });
  const comments = useMemo(
    () => annotations.filter(annotation => annotation.comment),
    [annotations],
  );

  const toc = analysis?.document.toc;
  const activeSearchPage = searchMatches[activeSearchIndex]?.page;
  const rail = useMemo<PdfReaderRail | null>(() => {
    if (!ready || !renderRail) return null;
    const marks = new Map<string, PdfReaderRailMark>();
    for (const annotation of annotations) {
      const page = annotation.range.start.page;
      marks.set(`h${page}`, marks.get(`h${page}`) ?? {
        page,
        kind: 'highlight',
        rgb: HIGHLIGHT_COLOR_RGB[annotation.color],
      });
    }
    for (const match of searchMatches) {
      marks.set(`s${match.page}`, {
        page: match.page,
        kind: 'search',
        active: match.page === activeSearchPage,
      });
    }
    return {
      pageCount: controllerRef.current?.pageCount() ?? 0,
      sections: (toc ?? []).map(entry => ({
        title: entry.title,
        page: entry.page,
        depth: entry.depth,
        top: entry.destinationY ?? 0,
      })),
      marks: [...marks.values()],
      position: () => railPositionRef.current,
      subscribe: listener => {
        railListenersRef.current.add(listener);
        return () => railListenersRef.current.delete(listener);
      },
      goTo: (page, top = 0) =>
        controllerRef.current?.scrollToBounds(page, {
          left: 0.5,
          right: 0.5,
          top,
          bottom: top,
        }),
      preview: page => controllerRef.current?.thumbnail(page) ?? Promise.resolve(null),
      openOutline: () => setActivePanel('outline'),
    };
  }, [activeSearchPage, annotations, ready, renderRail, searchMatches, toc]);

  useEffect(() => {
    if (!ready || !searchTarget || readerIdentity !== searchTarget.documentHash) return;
    const controller = controllerRef.current;
    const overlay = overlayRef.current;
    if (!controller || !overlay) return;
    let cancelled = false;
    const bounds = searchTarget.rects.map(([x, y, width, height]) => ({ left: x / 65535, top: y / 65535, right: (x + width) / 65535, bottom: (y + height) / 65535 }));
    const match: ReaderSearchMatch = { id: searchTarget.id, page: searchTarget.page, start: 0, end: 0, preview: searchTarget.targetText, bounds };
    void controller.preparePage(searchTarget.page).then(() => {
      if (cancelled) return;
      const box = unionBounds(bounds);
      if (box) controller.zoomToBounds(searchTarget.page, box);
      else controller.scrollToBounds(searchTarget.page, bounds[0]);
      overlay.setResultTarget(match);
      void overlay.ensurePage(searchTarget.page).catch(error => setStatus(String(error)));
    }).catch(error => { if (!cancelled) setStatus(`Could not open result: ${error}`); });
    return () => { cancelled = true; overlay.setResultTarget(null); };
  }, [ready, readerIdentity, searchTarget]);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => setReaderZoom(zoom * 1.2),
      zoomOut: () => setReaderZoom(zoom / 1.2),
      actualSize: () => {
        controllerRef.current?.actualSize();
        setZoom(controllerRef.current?.currentZoom() ?? 1);
      },
      fitWidth: () => {
        controllerRef.current?.fitWidth();
        setZoom(controllerRef.current?.currentZoom() ?? 1);
      },
      setSearchQuery,
      previousSearchResult: () =>
        activateSearch(searchMatches, activeSearchIndex - 1),
      nextSearchResult: () =>
        activateSearch(searchMatches, activeSearchIndex + 1),
      activateSearchResult: index => activateSearch(searchMatches, index),
      activateComment: id => {
        const annotation = comments.find(comment => comment.id === id);
        if (!annotation) return;
        void openAnnotationEditor(annotation);
      },
      showMark: id => {
        const mark = hostMarksRef.current?.find(m => m.id === id);
        const controller = controllerRef.current;
        if (!mark || !controller) return false;
        const bounds = toBounds(mark.rects);
        void controller.preparePage(mark.page).then(() => {
          const box = unionBounds(bounds);
          if (box) controller.centerOnBounds(mark.page, box);
          else controller.scrollToBounds(mark.page, { left: 0, right: 0, top: 0, bottom: 0 });
          requestAnimationFrame(() => overlayRef.current?.flashHostMark(id));
        }).catch(() => {});
        return true;
      },
      focusAnnotation: (id, fallbackPage, quote) => {
        const controller = controllerRef.current;
        const overlay = overlayRef.current;
        if (!controller) return;
        const annotation = id ? annotations.find(a => a.id === id) : undefined;
        const anchor = annotation?.anchor?.pages[0];
        const page = anchor?.page ?? annotation?.range.start.page ?? fallbackPage;
        if (page === undefined) return;
        void controller.preparePage(page).then(async () => {
          let bounds = anchor?.bounds ?? [];
          // A quote from a note: find its words on the page to centre on them.
          let passage = false;
          if (!bounds.length && quote?.trim() && overlay) {
            await overlay.ensurePage(page).catch(() => undefined);
            const text = overlay.textPages.get(page);
            const range = text ? locateQuote(text, quote) : null;
            if (text && range) {
              bounds = boundsForRange(text, range);
              passage = bounds.length > 0;
            }
          }
          // The whole passage, so it can be centred and fitted.
          const box = unionBounds(bounds);
          if (box) controller.zoomToBounds(page, box);
          else controller.centerOnBounds(page, undefined);
          if (!overlay) return;
          if (annotation) {
            void overlay.ensurePage(page).then(() => overlay.flashAnnotation(annotation.id)).catch(() => {});
          } else if (passage) {
            overlay.flashBounds(page, bounds);
          }
        }).catch(error => setStatus(`Could not show the passage: ${error}`));
      },
      closeSearch: () => {
        setSearchQuery('');
        setActivePanel(current => (current === 'search' ? null : current));
      },
      togglePanel: panel =>
        setActivePanel(current => (current === panel ? null : panel)),
      closePanel: () => setActivePanel(null),
      goTo: (page, top = 0) =>
        controllerRef.current?.scrollToBounds(page, { left: 0, right: 0, top, bottom: top }),
      renderRegion: (page, rect, width) => controllerRef.current?.renderRegion(page, rect, width) ?? Promise.resolve(null),
      addHighlightAt: (range, text, color, comment) => {
        const documentId = documentIdRef.current;
        if (!documentId) return undefined;
        const now = new Date().toISOString();
        const created: ReaderAnnotation = { id: annotationId(), documentId, range, text, color, createdAt: now, updatedAt: now, ...(comment?.trim() ? { comment: comment.trim() } : {}) };
        updateAnnotations([...annotationSnapshotRef.current, created]);
        return created.id;
      },
      updateAnnotation: (id, patch) => {
        const current = annotationSnapshotRef.current;
        if (!current.some(a => a.id === id)) return false;
        const now = new Date().toISOString();
        updateAnnotations(
          current.map(a =>
            a.id === id
              ? { ...a, ...(patch.color ? { color: patch.color } : {}), ...(patch.comment !== undefined ? { comment: patch.comment.trim() || undefined } : {}), updatedAt: now }
              : a,
          ),
        );
        return true;
      },
      removeAnnotation: id => {
        const current = annotationSnapshotRef.current;
        if (!current.some(a => a.id === id)) return false;
        updateAnnotations(current.filter(a => a.id !== id));
        return true;
      },
    }),
    [
      activateSearch,
      activeSearchIndex,
      annotations,
      comments,
      openAnnotationEditor,
      searchMatches,
      setReaderZoom,
      updateAnnotations,
      zoom,
    ],
  );

  useEffect(() => {
    onChromeStateChangeRef.current?.({
      ready,
      title: initialFile?.name ?? paneTitle,
      zoom,
      pageCount: controllerRef.current?.pageCount() ?? 0,
      status,
      searchQuery,
      searchCount: searchMatches.length,
      activeSearchIndex,
      searchResults: searchMatches.slice(0, 256).map(match => ({
        id: match.id,
        page: match.page,
        preview: match.preview,
      })),
      searching,
      activePanel,
      commentCount: comments.length,
      comments: comments.map(comment => ({
        id: comment.id,
        page: comment.range.start.page,
        text: comment.text,
        comment: comment.comment ?? '',
        color: comment.color,
        accentRgb: HIGHLIGHT_COLOR_RGB[comment.color],
      })),
      activeCommentId: activeAnnotation?.comment ? activeAnnotation.id : null,
      outlineCount: analysis?.document.toc.length ?? 0,
      referenceCount: libraryReferences?.length || analysis?.references.length || 0,
    });
  }, [
    activePanel,
    activeAnnotation,
    activeSearchIndex,
    analysis,
    comments,
    initialFile?.name,
    paneTitle,
    ready,
    searchMatches.length,
    searchQuery,
    searching,
    status,
    zoom,
  ]);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('benchmark')) return;
    window.__PDFJS_RUN_BENCHMARK__ = benchmark;
    return () => {
      if (window.__PDFJS_RUN_BENCHMARK__ === benchmark) delete window.__PDFJS_RUN_BENCHMARK__;
    };
  }, [benchmark]);

  useEffect(() => {
    if (!ready || !autoRunBenchmarkRef.current || running) return;
    autoRunBenchmarkRef.current = false;
    const timer = window.setTimeout(() => void benchmark(), 250);
    return () => window.clearTimeout(timer);
  }, [benchmark, ready, running]);

  return (
    <main
      className={`pdfjs-benchmark ${embedded ? 'embedded' : ''}`}
      onPointerDownCapture={event => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest('.pdfjs-cite-card, .pdfjs-citation-modal')
        ) {
          return;
        }
        setSelectedCitation(null);
        setHoveredCitation(null);
        setExternalCitation(null);
        setExternalCitationExpanded(false);
      }}
    >
      {!embedded && <header className="pdfjs-benchmark-toolbar" aria-label="Within PDF controls">
        <div className="pdfjs-pane-title">
          <Icon name="document" />
          <strong>{paneTitle}</strong>
        </div>
        {!embedded && (
          <label className="pdfjs-file-button">
            Open PDF
            <input
              type="file"
              accept="application/pdf"
              onChange={event => {
                const file = event.currentTarget.files?.[0];
                if (file) void load(file);
              }}
            />
          </label>
        )}
        <div className="pdfjs-toolbar-group" aria-label="Zoom controls">
          <IconButton
            icon="zoom_out"
            label="Zoom out"
            disabled={!ready}
            onClick={() => setReaderZoom(zoom / 1.2)}
          />
          <button
            type="button"
            disabled={!ready}
            className="pdfjs-zoom-value"
            onClick={() => {
              controllerRef.current?.actualSize();
              setZoom(controllerRef.current?.currentZoom() ?? 1);
            }}
            title="Actual size"
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton
            icon="zoom_in"
            label="Zoom in"
            disabled={!ready}
            onClick={() => setReaderZoom(zoom * 1.2)}
          />
          <IconButton
            icon="fit_width"
            label="Fit width"
            selected={Math.abs(zoom - 1) < 0.01}
            disabled={!ready}
            onClick={() => {
              controllerRef.current?.fitWidth();
              setZoom(controllerRef.current?.currentZoom() ?? 1);
            }}
          />
        </div>
        <div className="pdfjs-search-box">
          <Icon name="search" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            disabled={!ready}
            placeholder="Search this PDF"
            aria-label="Search this PDF"
            onChange={event => {
              const value = event.currentTarget.value;
              setSearchQuery(value);
              if (value.trim()) setActivePanel('search');
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              activateSearch(
                searchMatches,
                activeSearchIndex + (event.shiftKey ? -1 : 1),
              );
            }}
            onFocus={() => {
              if (searchQuery) setActivePanel('search');
            }}
          />
          {searching ? (
            <span className="pdfjs-search-spinner" aria-label="Searching" />
          ) : (
            <span className="pdfjs-search-count">
              {searchQuery
                ? searchMatches.length
                  ? `${activeSearchIndex + 1}/${searchMatches.length}`
                  : '0'
                : ''}
            </span>
          )}
          <IconButton
            icon="previous"
            label="Previous search result"
            disabled={!searchMatches.length}
            onClick={() => activateSearch(searchMatches, activeSearchIndex - 1)}
          />
          <IconButton
            icon="next"
            label="Next search result"
            disabled={!searchMatches.length}
            onClick={() => activateSearch(searchMatches, activeSearchIndex + 1)}
          />
        </div>
        <div className="pdfjs-toolbar-spacer" />
        <IconButton
          icon="book"
          label="Document outline"
          selected={activePanel === 'outline'}
          disabled={!ready || !analysis?.document.toc.length}
          onClick={() => setActivePanel(panel => panel === 'outline' ? null : 'outline')}
        />
        <IconButton
          icon="highlight"
          label="Paper references"
          selected={activePanel === 'references'}
          disabled={!ready || !analysis?.references.length}
          onClick={() => setActivePanel(panel => panel === 'references' ? null : 'references')}
        />
        <IconButton
          icon="comments"
          label={`Comments${comments.length ? ` (${comments.length})` : ''}`}
          selected={activePanel === 'comments'}
          disabled={!ready}
          onClick={() => setActivePanel(panel => panel === 'comments' ? null : 'comments')}
        />
        <span className="pdfjs-status" title={status}>
          <i className={ready ? 'ready' : ''} />
          {ready ? `${controllerRef.current?.pageCount() ?? 0} pages` : status}
        </span>
      </header>}
      <div ref={scrollRef} className="pdfjs-scroll">
        <div ref={contentRef} className="pdfjs-content" />
      </div>
      {rail && renderRail?.(rail)}
      <div
        className={`pdfjs-loading-veil ${ready ? 'ready' : ''}`}
        aria-hidden={ready}
      >
        {previewUrl && (
          <img
            className="pdfjs-loading-preview"
            src={previewUrl}
            alt=""
          />
        )}
        <span>
          <i className="pdfjs-loading-spinner" aria-hidden="true" />
          {status}
        </span>
      </div>
      {context && !commentDraft && activeAnnotation && !selection && annotationInfo && (
        <HighlightInfo
          text={activeAnnotation.text}
          comment={activeAnnotation.comment}
          color={activeAnnotation.color}
          colors={Object.fromEntries(HIGHLIGHT_COLORS.map(color => [color, HIGHLIGHT_COLOR_RGB[color]]))}
          createdAt={activeAnnotation.createdAt}
          updatedAt={activeAnnotation.updatedAt}
          place={`p. ${activeAnnotation.range.start.page + 1}`}
          usage={annotationUsage}
          renderComment={comment => <MarkdownContent markdown={comment} />}
          style={(() => {
            // In the reader's own box (beside a sidebar), and where fixed boxes start.
            const area = scrollRef.current?.getBoundingClientRect();
            const lo = Math.max(12, (area?.left ?? 0) + 8);
            const hi = Math.min(window.innerWidth, area?.right ?? window.innerWidth) - 320;
            const origin = fixedOrigin(rootRef.current);
            const top =
              context.bottom + 300 < window.innerHeight
                ? context.bottom + 10
                : context.top - 300 > 54
                  ? Math.max(54, context.top - 10 - 300)
                  : Math.max(54, Math.min(window.innerHeight - 320, context.bottom + 10));
            return { left: Math.max(lo, Math.min(hi, context.left + context.width / 2 - 156)) - origin.x, top: top - origin.y };
          })()}
          onColor={color => addHighlight(color as HighlightColor)}
          onComment={openCommentEditor}
          onCopy={() => void copyContextText()}
          onCite={onCite ? citeContext : undefined}
          onDelete={removeActiveAnnotation}
        />
      )}
      <SelectionMenu
        open={!!context && !commentDraft && !(activeAnnotation && !selection && annotationInfo) && !(selection && pickSelection)}
        anchor={context ?? null}
        area={() => scrollRef.current?.getBoundingClientRect() ?? rootRef.current?.getBoundingClientRect()}
        label={selection ? 'Text selection actions' : 'Annotation actions'}
        passage={selectedPassage}
        actions={selection ? selectionActions : undefined}
        mode={selection && selectionActions ? selectionMode : undefined}
        colors={HIGHLIGHT_COLORS.map(color => ({
          id: color,
          label: `${color} highlight`,
          rgb: HIGHLIGHT_COLOR_RGB[color],
          pressed: activeAnnotation?.color === color,
          run: () => void addHighlight(color),
        }))}
        tools={[
          { id: 'copy', label: 'Copy selected text', title: 'Copy', icon: 'copy', run: () => void copyContextText() },
          ...(onCite ? [{ id: 'cite', label: 'Cite', title: 'Copy as a quote with its source', icon: 'quote' as const, run: citeContext }] : []),
          onAddToNote
            ? {
                id: 'to-note',
                label: 'Add to note',
                title: "Quote this passage in the source's note",
                icon: 'note' as const,
                text: true,
                run: () => {
                  const text = (selection?.text ?? activeAnnotation?.text ?? '').trim();
                  const page = selection?.range.start.page ?? activeAnnotation?.range.start.page ?? 0;
                  if (!text) return;
                  onAddToNote({ text, page, color: activeAnnotation?.color });
                  window.getSelection()?.removeAllRanges();
                  setStatus('Added to note');
                },
              }
            : { id: 'comment', label: activeAnnotation?.comment ? 'Edit note' : 'Add note', icon: 'comment' as const, run: openCommentEditor },
          ...(activeAnnotation ? [{ id: 'delete', label: 'Delete annotation', title: 'Delete', icon: 'trash' as const, danger: true, run: removeActiveAnnotation }] : []),
        ]}
        onDone={() => {
          overlayRef.current?.clearBrowserSelection();
          setSelection(null);
          setContextRect(null);
        }}
        onClose={() => {
          overlayRef.current?.clearBrowserSelection();
          setSelection(null);
          setActiveAnnotation(null);
          setContextRect(null);
        }}
      />
      <SelectionMenu
        open={!!markMenu}
        anchor={markMenu?.rect ?? null}
        area={() => scrollRef.current?.getBoundingClientRect() ?? rootRef.current?.getBoundingClientRect()}
        label={markMenu?.menu.title ?? 'Mark'}
        title={markMenu?.menu.title}
        passage={() => (markMenu ? { text: markMenu.mark.text, page: markMenu.mark.page, rects: markMenu.mark.rects } : null)}
        actions={markMenu?.menu.actions}
        mode={markMenu?.menu.mode}
        onDone={() => setMarkMenu(null)}
        onClose={() => setMarkMenu(null)}
      />
      {hoveredLink && !context && (
        <LiveAnchoredCard
          className="pdfjs-link-card"
          resolveAnchor={resolveHoveredLinkAnchor}
          gap={12}
          onPointerEnter={cancelLinkHoverExit}
          onPointerLeave={scheduleLinkHoverExit}
        >
          <span><Icon name={hoveredLink.link.synthetic ? 'highlight' : 'document'} /></span>
          <div>
            <strong>{citationPreview(hoveredLink.link, analysis).title}</strong>
            <small>{citationPreview(hoveredLink.link, analysis).detail}</small>
          </div>
          <Icon name="next" />
        </LiveAnchoredCard>
      )}
      {citationFocus && !context && (
        <LiveAnchoredCard
          className="pdfjs-cite-card"
          data-expanded={expandedCitationNumber !== null || undefined}
          role="dialog"
          aria-label={
            citationFocus.citation.numbers.length > 1
              ? `${citationFocus.citation.numbers.length} cited works`
              : 'Cited work'
          }
          resolveAnchor={resolveCitationAnchor}
          gap={8}
          onPointerDown={event => event.stopPropagation()}
          onPointerEnter={cancelCitationHoverExit}
          onPointerLeave={event => {
            // The card can move under a still pointer as it grows; back over the citation it stays.
            const anchor = resolveCitationAnchor();
            const overCitation =
              !!anchor &&
              event.clientX >= anchor.left - 2 &&
              event.clientX <= anchor.right + 2 &&
              event.clientY >= anchor.top - 2 &&
              event.clientY <= anchor.bottom + 2;
            if (!selectedCitation && !overCitation) scheduleCitationHoverExit();
          }}
        >
          <CitationCardBody
            citation={citationFocus.citation}
            active={selectedActiveCitationNumber}
            onSelect={number => {
              setActiveCitationNumber(number);
              setExpandedCitationNumber(current => (current === null ? null : number));
            }}
            expanded={expandedCitationNumber !== null}
            onCollapse={() => setExpandedCitationNumber(null)}
            reference={number => referenceForNumber(analysis, number)}
            entry={number => scholarly.get(number)}
            onResolved={resolveScholarly}
            uiId={citationUiId}
            libraryAction={referenceInLibrary}
            libraryWorks={libraryWorks}
            onGoToReference={reference =>
              controllerRef.current?.scrollToBounds(reference.page, {
                left: reference.xFraction ?? 0,
                right: reference.xFraction ?? 0,
                top: reference.yFraction ?? 0,
                bottom: reference.yFraction ?? 0,
              })
            }
            onShowMore={number => {
              setSelectedCitation(citationFocus);
              setActiveCitationNumber(number);
              setExpandedCitationNumber(number);
            }}
            onClose={
              selectedCitation
                ? () => {
                    setSelectedCitation(null);
                    setHoveredCitation(null);
                    setExpandedCitationNumber(null);
                  }
                : undefined
            }
          />
        </LiveAnchoredCard>
      )}
      {externalCitation && !context && (
        <LiveAnchoredCard
          className="pdfjs-cite-card"
          data-expanded={externalCitationExpanded || undefined}
          role="dialog"
          aria-label="Linked research"
          resolveAnchor={resolveExternalCitationAnchor}
          gap={8}
          onPointerDown={event => event.stopPropagation()}
        >
          <ExternalWorkCardBody
            url={externalCitation.link.target.kind === 'external' ? externalCitation.link.target.url : ''}
            libraryWorks={libraryWorks}
            onResolved={resolveExternal}
            onShowMore={() => setExternalCitationExpanded(true)}
            expanded={externalCitationExpanded}
            onCollapse={() => setExternalCitationExpanded(false)}
            onClose={() => {
              externalCitationRequestRef.current += 1;
              setExternalCitation(null);
              setExternalCitationExpanded(false);
            }}
          />
        </LiveAnchoredCard>
      )}
      {activePanel === 'search' && (
        <PanelShell
          title="Search"
          detail={
            searching
              ? 'Searching document…'
              : `${searchMatches.length} ${searchMatches.length === 1 ? 'result' : 'results'}`
          }
          icon="search"
          onClose={() => setActivePanel(null)}
          className="pdfjs-reader-panel"
        >
          {searchMatches.length ? (
            <div className="pdfjs-result-list">
              {searchMatches.map((match, index) => (
                <button
                  type="button"
                  key={match.id}
                  className={index === activeSearchIndex ? 'active' : ''}
                  onClick={() => activateSearch(searchMatches, index)}
                >
                  <span>Page {match.page + 1}</span>
                  <p>{match.preview}</p>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon="search"
              title={searchQuery ? 'No matches' : 'Search this document'}
              detail={
                searchQuery
                  ? `Nothing matched “${searchQuery}”.`
                  : 'Type in the search field to find text across every page.'
              }
            />
          )}
        </PanelShell>
      )}
      {activePanel === 'comments' && (
        <PanelShell
          title="Comments"
          detail={`${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`}
          icon="comments"
          onClose={() => setActivePanel(null)}
          className="pdfjs-reader-panel"
        >
          {comments.length ? (
            <div className="pdfjs-comment-list" aria-label="Document comments">
              {comments.map(comment => (
                <button
                  key={comment.id}
                  type="button"
                  className={activeAnnotation?.id === comment.id ? 'active' : ''}
                  onClick={() => void openAnnotationEditor(comment)}
                >
                  <span
                    className={`pdfjs-comment-swatch color-${comment.color}`}
                    style={{ background: `rgb(${HIGHLIGHT_COLOR_RGB[comment.color]})` }}
                  />
                  <span>
                    <small>Page {comment.range.start.page + 1}</small>
                    <AnnotationText
                      text={comment.text}
                      comment={comment.comment}
                      rgb={HIGHLIGHT_COLOR_RGB[comment.color]}
                      renderComment={markdown => <MarkdownContent markdown={markdown} />}
                    />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon="comments"
              title="No comments yet"
              detail="Select text in the PDF and choose Add note to start a comment."
            />
          )}
        </PanelShell>
      )}
      {activePanel === 'outline' && (
        <PanelShell
          title="Document outline"
          detail={`${analysis?.document.toc.length ?? 0} sections`}
          icon="book"
          onClose={() => setActivePanel(null)}
          className="pdfjs-reader-panel"
        >
          {analysis?.document.toc.length ? (
            <nav className="pdfjs-outline-list" aria-label="Document outline">
              {analysis.document.toc.map((entry, index) => (
                <button
                  type="button"
                  key={`${entry.page}-${entry.title}-${index}`}
                  style={{ '--outline-depth': entry.depth } as React.CSSProperties}
                  onClick={() =>
                    controllerRef.current?.scrollToBounds(entry.page, {
                      left: 0,
                      right: 0,
                      top: entry.destinationY ?? 0,
                      bottom: entry.destinationY ?? 0,
                    })
                  }
                >
                  <span>{entry.title}</span>
                  <small>{entry.page + 1}</small>
                </button>
              ))}
            </nav>
          ) : (
            <EmptyState
              icon="book"
              title="No document outline"
              detail="This PDF does not contain a table of contents."
            />
          )}
        </PanelShell>
      )}
      {activePanel === 'references' && (
        <SidePanel
          label="References"
          className="pdfjs-side-panel"
          storageKey="key.reader.side-panel"
          resizable={{ min: 260, max: 560, initial: 340 }}
          sections={[
            {
              id: 'references',
              title: 'References',
              badge: (libraryReferences?.length || analysis?.references.length) || undefined,
              render: () => (
                <ReferenceList
                  header={referencesHeader}
                  references={libraryReferences?.length ? libraryReferences : analysis?.references ?? libraryReferences}
                  aside={referenceAside}
                  onSelect={reference =>
                    controllerRef.current?.scrollToBounds(reference.page, {
                      left: reference.xFraction ?? 0,
                      right: reference.xFraction ?? 0,
                      top: reference.yFraction ?? 0,
                      bottom: reference.yFraction ?? 0,
                    })
                  }
                />
              ),
            },
          ]}
          actions={
            <button type="button" aria-label="Close references" title="Close" onClick={() => setActivePanel(null)}>
              <Icon name="close" />
            </button>
          }
        />
      )}
      {commentDraft && commentAnchorRect && (
        <LiveAnchoredCard
          className={`pdfjs-comment-anchor-card ${
            commentEditorExpanded ? 'expanded' : ''
          }`}
          role="dialog"
          aria-label="Comment editor"
          resolveAnchor={() =>
            overlayRef.current?.viewportRectForRange(commentDraft.range) ??
            commentAnchorRect ?? undefined
          }
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setCommentDraft(null);
              setCommentAnchorRect(null);
              setCommentEditorExpanded(false);
            }
          }}
        >
          {!commentEditorExpanded ? (
            <>
              <span><Icon name="comments" /></span>
              <button
                type="button"
                className="pdfjs-comment-anchor-open"
                onClick={() => setCommentEditorExpanded(true)}
              >
                Add comment
              </button>
              <IconButton
                icon="expand"
                label="Expand comment editor"
                onClick={() => setCommentEditorExpanded(true)}
              />
            </>
          ) : (
            <div className="pdfjs-comment-editor">
              <blockquote>{commentDraft.text.trim() || 'Selected text'}</blockquote>
              <MarkdownEditor
                autoFocus
                value={commentDraft.comment}
                placeholder="Write a comment…"
                ariaLabel="Comment"
                onChange={comment => {
                  setCommentError('');
                  setCommentDraft({ ...commentDraft, comment });
                }}
              />
              {commentError && <p className="pdfjs-comment-error">{commentError}</p>}
              <div className="pdfjs-comment-actions">
                <button
                  type="button"
                  onClick={() => {
                    setCommentDraft(null);
                    setCommentAnchorRect(null);
                    setCommentEditorExpanded(false);
                  }}
                >
                  Cancel
                </button>
                <button type="button" className="primary" onClick={saveComment} title="Save (⌘↩)">
                  Save comment
                </button>
              </div>
            </div>
          )}
        </LiveAnchoredCard>
      )}
    </main>
  );
});

export default PdfJsBenchmarkApp;
