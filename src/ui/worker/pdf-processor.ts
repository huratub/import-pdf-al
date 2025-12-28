import * as pdfjsLib from 'pdfjs-dist';
import { groupTextItems, Paragraph, TextItem } from './paragraph-grouper';

// Set worker source to CDN for simplicity in Figma plugin environment (avoids complex vite worker bundling)
// In a production app you might want to bundle this, but for this plugin CDN is reliable enough.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
(pdfjsLib.GlobalWorkerOptions as any).verbosity = pdfjsLib.VerbosityLevel.ERRORS; // Silence warnings

export interface PageData {
    width: number;
    height: number;
    items: Paragraph[];
    links?: Array<{ x: number, y: number, w: number, h: number, url: string }>;
    svg?: string;
    svgSanitized?: string;
    svgUltraSafe?: string; // New: Aggressively sanitized fallback
    image?: Uint8Array;
    extractedImages?: Array<{
        x: number, y: number, width: number, height: number,
        data: Uint8Array, transform: number[]
    }>;
    nativePaths?: Array<{
        d: string;
        fill?: { r: number, g: number, b: number };
        stroke?: { r: number, g: number, b: number, width: number };
        opacity?: number;
        transform: number[];
    }>;
    fonts?: string[]; // Unique font families
}

export class PDFProcessor {
    private pdf: pdfjsLib.PDFDocumentProxy | null = null;

    async load(data: ArrayBuffer) {
        const loadingTask = pdfjsLib.getDocument({ data });
        this.pdf = await loadingTask.promise;
        return this.pdf.numPages;
    }

    async getPageData(pageIndex: number): Promise<PageData> {
        if (!this.pdf) throw new Error("PDF not loaded");

        // Monkey-patch console.warn to silence specific PDF.js "Unimplemented" warnings
        const originalWarn = console.warn;
        console.warn = (...args) => {
            const msg = args.join(' ');
            if (msg.includes('Unimplemented operator') || msg.includes('Warning: Unimplemented')) {
                return; // Ignore
            }
            originalWarn.apply(console, args);
        };

        try {
            // Pages are 1-indexed in PDF.js
            const page = await this.pdf.getPage(pageIndex + 1);
            const viewport = page.getViewport({ scale: 1.0 });

            // 1. Extract Text
            // disableCombineTextItems: true -> Extracts every glyph/kerning-pair separately. 
            // This is necessary for "Actual glyph positions".
            const textContent = await page.getTextContent({ disableCombineTextItems: true } as any);

            // Use RenderTextLayer to extract correct styles (Color, Bold, Italic) from CSS
            const styleMap = new Map<number, {
                color: string,
                opacity: number,
                weight: string | number,
                style: string,
                family: string,
                fontSize: number,
                lineHeight: number,
                letterSpacing: number,
                wordSpacing: number,
                stroke?: { color: string, width: number, opacity: number }
            }>();

            const uniqueFonts = new Set<string>();

            try {
                const container = document.createElement('div');
                container.style.display = 'none'; // hidden but in DOM
                document.body.appendChild(container);

                // Check availability of renderTextLayer
                const renderTextLayer = (pdfjsLib as any).renderTextLayer;
                if (renderTextLayer) {
                    const renderTask = renderTextLayer({
                        textContentSource: textContent,
                        container,
                        viewport,
                        textDivs: []
                    });
                    await renderTask.promise;

                    const spans = Array.from(container.querySelectorAll('span'));
                    spans.forEach((span, index) => {
                        const cs = window.getComputedStyle(span);

                        // FontSize
                        const fontSizePx = parseFloat(cs.fontSize) || 0;

                        // LineHeight
                        let lineHeightPx = fontSizePx * 1.2; // default normal
                        if (cs.lineHeight && cs.lineHeight !== 'normal') {
                            lineHeightPx = parseFloat(cs.lineHeight);
                        }

                        // LetterSpacing
                        let letterSpacingPx = 0;
                        if (cs.letterSpacing && cs.letterSpacing !== 'normal') {
                            letterSpacingPx = parseFloat(cs.letterSpacing);
                        }

                        // WordSpacing
                        let wordSpacingPx = 0;
                        if (cs.wordSpacing && cs.wordSpacing !== 'normal') {
                            wordSpacingPx = parseFloat(cs.wordSpacing);
                        }

                        const family = cs.fontFamily ? cs.fontFamily.replace(/['"]/g, '') : 'Inter';
                        uniqueFonts.add(family);

                        // Stroke Extraction (Webkit)
                        let stroke: { color: string, width: number, opacity: number } | undefined;
                        const webkitStrokeWidth = cs.webkitTextStrokeWidth;
                        if (webkitStrokeWidth && parseFloat(webkitStrokeWidth) > 0) {
                            const width = parseFloat(webkitStrokeWidth);
                            const strokeColor = cs.webkitTextStrokeColor || 'rgb(0,0,0)';
                            stroke = { color: strokeColor, width, opacity: 1 };
                        }

                        // Opacity
                        const opacity = parseFloat(cs.opacity) || 1;

                        styleMap.set(index, {
                            color: cs.color || 'rgb(0,0,0)',
                            opacity,
                            weight: cs.fontWeight || '400',
                            style: cs.fontStyle || 'normal',
                            family: family,
                            fontSize: fontSizePx,
                            lineHeight: lineHeightPx,
                            letterSpacing: letterSpacingPx,
                            wordSpacing: wordSpacingPx,
                            stroke
                        });
                    });
                }
                document.body.removeChild(container);
            } catch (e) {
                console.warn("Text Layer style extraction failed", e);
            }

            const rawItems: TextItem[] = [];
            const items = textContent.items as any[];

            // Pre-resolve fonts from commonObjs to get real PostScript names
            // item.fontName is just a reference ID like "g_d0_f1"
            // page.commonObjs.get("g_d0_f1") returns the Font object.
            const fontObjects = new Map<string, any>();
            try {
                // In PDF.js, commonObjs is a helper. We need to ensure they are resolved.
                // The textContent call usually ensures fonts are loaded, but commonObjs might be populated async or synced.
                // We can iterate unique font names from items and try to get them.
                for (const it of items) {
                    if (it.fontName && !fontObjects.has(it.fontName)) {
                        // @ts-ignore - commonObjs access
                        if (page.commonObjs && page.commonObjs.has(it.fontName)) {
                            // @ts-ignore
                            const fontObj = page.commonObjs.get(it.fontName);
                            fontObjects.set(it.fontName, fontObj);
                        }
                    }
                }
            } catch (e) {
                console.warn("Font Object extraction failed", e);
            }

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const domStyles = styleMap.get(i);
                const loadedFont = fontObjects.get(item.fontName);

                // Fallbacks
                let weight: string | number = 400;
                let fontStyle = 'normal';
                let color = domStyles?.color || 'rgb(0, 0, 0)';
                let opacity = domStyles?.opacity ?? 1;
                let fontFamily = 'Inter';
                let extractedFontSize = 0;
                let extractedLineHeight = 0;
                let extractedLetterSpacing = 0;
                let extractedWordSpacing = 0;
                let stroke = domStyles?.stroke;

                if (domStyles) {
                    weight = domStyles.weight;
                    fontStyle = domStyles.style;
                    fontFamily = domStyles.family;
                    extractedFontSize = domStyles.fontSize;
                    extractedLineHeight = domStyles.lineHeight;
                    extractedLetterSpacing = domStyles.letterSpacing;
                    extractedWordSpacing = domStyles.wordSpacing;
                }

                // Calculate geometric font size as backup or verification
                const tx = item.transform as number[]; // [a, b, c, d, tx, ty]
                const geoFontSize = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);

                // Prefer the computed font size if it's close to geometry, otherwise geometry might be more accurate for pure scale.
                // Font Family Cleaning & Generic Mapping
                if (fontFamily) {
                    // Remove quotes
                    fontFamily = fontFamily.replace(/['"]/g, '');

                    // Map Generics to Figma-safe defaults
                    const lower = fontFamily.toLowerCase();
                    if (lower.includes('sans-serif') || lower === 'sans-serif') fontFamily = 'Inter';
                    else if (lower.includes('serif')) fontFamily = 'Times New Roman'; // Figma usually has this or similar
                    else if (lower.includes('monospace')) fontFamily = 'Roboto Mono';
                }

                let finalFontSize = extractedFontSize > 0 ? extractedFontSize : geoFontSize;
                if (finalFontSize === 0) finalFontSize = 12; // safety fallback

                rawItems.push({
                    type: 'text',
                    str: item.str,
                    x: tx[4],
                    y: tx[5],
                    fontSize: finalFontSize,
                    fontFamily: fontFamily,
                    fontName: item.fontName, // Internal ID (e.g. "g_d0_f1")
                    rawFontName: loadedFont?.name || '', // PostScript Name (e.g. "Arial-BoldMT")
                    fontWeight: weight,
                    fontStyle: fontStyle,
                    color: color,
                    opacity: opacity,
                    stroke: stroke,
                    lineHeight: extractedLineHeight,
                    letterSpacing: extractedLetterSpacing,
                    wordSpacing: extractedWordSpacing,
                    horizontalScaling: 100, // Default, hard to extract from CSS alone
                    textRise: 0, // Default
                    textRenderMode: 0, // Default Fill
                    matrix: tx,
                    isRTL: item.dir === 'rtl',
                    width: item.width,
                    height: item.height,
                    transform: tx
                });
            }

            // 2. Group Paragraphs
            const paragraphs = groupTextItems(rawItems);

            // 3. Render Page to Image (Raster Fallback)
            // This ensures complex vectors and images are visible even if SVG fails.
            let imageBytes: Uint8Array | undefined;
            try {
                const canvas = document.createElement('canvas');
                const scale = 2.0; // Retina quality
                const viewportHighRes = page.getViewport({ scale });
                canvas.width = viewportHighRes.width;
                canvas.height = viewportHighRes.height;

                const context = canvas.getContext('2d');
                if (context) {
                    // Direct override instead of Proxy to be safer with PDF.js internal checks
                    const originalFillText = context.fillText;
                    const originalStrokeText = context.strokeText;

                    // No-op text rendering
                    context.fillText = () => { };
                    context.strokeText = () => { };

                    try {
                        await page.render({
                            canvasContext: context,
                            viewport: viewportHighRes
                        }).promise;
                    } finally {
                        // Restore just in case (though we discard this context)
                        context.fillText = originalFillText;
                        context.strokeText = originalStrokeText;
                    }

                    // Convert to blob/buffer
                    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
                    if (blob) {
                        const buffer = await blob.arrayBuffer();
                        imageBytes = new Uint8Array(buffer);
                    }
                }
            } catch (e) {
                console.error("Image Rendering failed", e);
            }

            // 4. Extract Vector (SVG) - Best Effort
            let svgString = '';
            let svgSanitizedString = '';
            let svgUltraSafeString = '';
            let svgElement: SVGElement | null = null; // Lifted scope

            try {
                try {
                    const operatorList = await page.getOperatorList();
                    const svgGraphics = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
                    svgElement = (await svgGraphics.getSVG(operatorList, viewport)) as unknown as SVGElement;
                    svgString = svgElement.outerHTML;
                } catch (e) {
                    console.warn("SVG Extraction (High Fidelity) crashed inside PDF.js - skipping vector layer.", e);
                    // Ensure we don't pass null/garbage
                    svgString = '';
                    svgElement = null;
                }

                // Pass B: Sanitized SVG (Clone and Strip)
                if (svgElement) {
                    try {
                        const clone = svgElement.cloneNode(true) as SVGElement;

                        // Preserve gradients, masks, clips, patterns, images.
                        // Only remove truly problematic or unsupported tags for Figma import (like foreignObject).
                        // We remove 'style' because inline CSS blocks often cause parsing errors in Figma or override attributes unexpectedly.
                        const badTags = ['foreignObject', 'object', 'embed', 'applet', 'script', 'style'];

                        badTags.forEach(tag => {
                            const elements = clone.querySelectorAll(tag);
                            elements.forEach(el => el.remove());
                        });

                        // Remove Text elements to avoid duplication with "Editable Text" layer
                        const textTags = ['text', 'tspan', 'textPath'];
                        textTags.forEach(tag => {
                            const elements = clone.querySelectorAll(tag);
                            elements.forEach(el => el.remove());
                        });

                        // Remove problematic attributes
                        // Remove problematic attributes?
                        // Figma handles most of these now, or ignores them.
                        const allElements = clone.querySelectorAll('*');
                        allElements.forEach(el => {
                            // el.removeAttribute('filter'); // Keep filters
                            // el.removeAttribute('mask'); // Keep masks for complex graphics
                            // el.removeAttribute('clip-path'); // Keep clips
                            el.removeAttribute('mix-blend-mode'); // Figma doesn't always import this from SVG well, but let's try leaving it or removing if buggy.
                            // Removing mix-blend-mode is safer for now as it often essentially hides content in Figma import.
                        });

                        svgSanitizedString = clone.outerHTML;
                    } catch (e) {
                        console.warn("SVG Sanitization failed", e);
                    }
                }

                // Pass C: Ultra-Safe SVG (No Masks, No Clips, No Patterns)
                if (svgElement) {
                    try {
                        const clone = svgElement.cloneNode(true) as SVGElement;
                        const badTags = ['foreignObject', 'object', 'embed', 'applet', 'script', 'style',
                            'mask', 'clipPath', 'filter', 'pattern', 'linearGradient', 'radialGradient', 'defs'];

                        badTags.forEach(tag => {
                            const elements = clone.querySelectorAll(tag);
                            elements.forEach(el => el.remove());
                        });

                        const textTags = ['text', 'tspan', 'textPath'];
                        textTags.forEach(tag => {
                            const elements = clone.querySelectorAll(tag);
                            elements.forEach(el => el.remove());
                        });

                        const allElements = clone.querySelectorAll('*');
                        allElements.forEach(el => {
                            el.removeAttribute('mask');
                            el.removeAttribute('clip-path');
                            el.removeAttribute('filter');
                            el.removeAttribute('fill-opacity'); // Sometimes causes issues
                            el.removeAttribute('stroke-opacity');
                            el.removeAttribute('mix-blend-mode');
                        });

                        svgUltraSafeString = clone.outerHTML;
                    } catch (e) {
                        console.warn("Ultra-Safe Sanitization failed", e);
                    }
                }

            } catch (e) {
                console.warn("SVG Extraction failed, falling back to raster image only.", e);
            }

            // 5. Extract Individual Images (Smart Extraction)
            const extractedImages: Array<any> = [];
            try {
                const ops = await page.getOperatorList();
                const fnArray = ops.fnArray;
                const argsArray = ops.argsArray;

                // transform stack
                let currentMatrix = [1, 0, 0, 1, 0, 0]; // Identity
                const transformStack: number[][] = [];

                // Helper to multiply matrices
                // m1 * m2
                const transform = (m1: number[], m2: number[]) => {
                    return [
                        m1[0] * m2[0] + m1[1] * m2[2],
                        m1[0] * m2[1] + m1[1] * m2[3],
                        m1[2] * m2[0] + m1[3] * m2[2],
                        m1[2] * m2[1] + m1[3] * m2[3],
                        m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
                        m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
                    ];
                };

                for (let i = 0; i < fnArray.length; i++) {
                    const fn = fnArray[i];
                    const args = argsArray[i];

                    if (fn === pdfjsLib.OPS.save) {
                        transformStack.push([...currentMatrix]);
                    }
                    else if (fn === pdfjsLib.OPS.restore) {
                        if (transformStack.length > 0) {
                            currentMatrix = transformStack.pop()!;
                        }
                    }
                    else if (fn === pdfjsLib.OPS.transform) {
                        // args: [a, b, c, d, e, f]
                        currentMatrix = transform(args, currentMatrix);
                    }
                    else if (fn === pdfjsLib.OPS.paintImageXObject) {
                        const imgName = args[0];
                        try {
                            // retrieve image
                            let imgObj: any;
                            if (page.objs.has(imgName)) {
                                imgObj = page.objs.get(imgName);
                            } else if (page.commonObjs.has(imgName)) {
                                imgObj = page.commonObjs.get(imgName);
                            }

                            if (imgObj && (imgObj.bitmap || imgObj.data)) {
                                // We have image data. Need to convert to PNG bytes for Figma.
                                // Use a temporary canvas.
                                const width = imgObj.width;
                                const height = imgObj.height;

                                if (width > 0 && height > 0) {
                                    const canvas = document.createElement('canvas');
                                    canvas.width = width;
                                    canvas.height = height;
                                    const ctx = canvas.getContext('2d');
                                    if (ctx) {
                                        // If it's an ImageBitmap (modern pdf.js)
                                        if (imgObj.bitmap) {
                                            ctx.drawImage(imgObj.bitmap, 0, 0);
                                        }
                                        // If it's raw data (older or different format)
                                        else if (imgObj.data) {
                                            // Handle raw data - this is complex (RGB vs RGBA vs CMYK)
                                            // Simplification: Assume RGBA for now or skip complex raw data
                                            const imageData = new ImageData(new Uint8ClampedArray(imgObj.data), width, height);
                                            ctx.putImageData(imageData, 0, 0);
                                        }

                                        // Convert to blob/bytes
                                        const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
                                        if (blob) {
                                            const buffer = await blob.arrayBuffer();
                                            // Position: The image is painted in the unit square (0,0,1,1) transformed by CTM.
                                            // We store the CTM and let Controller handle the Figma placement.
                                            extractedImages.push({
                                                data: new Uint8Array(buffer),
                                                transform: [...currentMatrix],
                                                width: width,
                                                height: height,
                                                x: currentMatrix[4], // approximate translation
                                                y: currentMatrix[5]
                                            });
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn(`Failed to extract image ${imgName}`, err);
                        }
                    }
                }
            } catch (e) {
                console.warn("Smart Image Extraction failed", e);
            }

            // 5.5 Extract Native Vectors (Path Operators)
            const nativePaths: Array<any> = [];
            try {
                const ops = await page.getOperatorList();
                const fnArray = ops.fnArray;
                const argsArray = ops.argsArray;

                let currentMatrix = [1, 0, 0, 1, 0, 0];
                const transformStack: number[][] = [];

                let currentPath = "";
                let fillColor = { r: 0, g: 0, b: 0 };
                let strokeColor = { r: 0, g: 0, b: 0 };
                let lineWidth = 1.0;
                let opacity = 1.0;

                const transform = (m1: number[], m2: number[]) => {
                    return [
                        m1[0] * m2[0] + m1[1] * m2[2],
                        m1[0] * m2[1] + m1[1] * m2[3],
                        m1[2] * m2[0] + m1[3] * m2[2],
                        m1[2] * m2[1] + m1[3] * m2[3],
                        m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
                        m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
                    ];
                };

                for (let i = 0; i < fnArray.length; i++) {
                    const fn = fnArray[i];
                    const args = argsArray[i];

                    if (fn === pdfjsLib.OPS.save) {
                        transformStack.push([...currentMatrix]);
                    }
                    else if (fn === pdfjsLib.OPS.restore) {
                        if (transformStack.length > 0) {
                            currentMatrix = transformStack.pop()!;
                        }
                    }
                    else if (fn === pdfjsLib.OPS.transform) {
                        currentMatrix = transform(args, currentMatrix);
                    }
                    // Color state
                    else if (fn === pdfjsLib.OPS.setFillRGBColor) {
                        fillColor = { r: args[0] / 255, g: args[1] / 255, b: args[2] / 255 };
                    }
                    else if (fn === pdfjsLib.OPS.setStrokeRGBColor) {
                        strokeColor = { r: args[0] / 255, g: args[1] / 255, b: args[2] / 255 };
                    }
                    else if (fn === pdfjsLib.OPS.setLineWidth) {
                        lineWidth = args[0];
                    }
                    // Path construction
                    else if (fn === pdfjsLib.OPS.moveTo) {
                        currentPath += `M ${args[0]} ${args[1]} `;
                    }
                    else if (fn === pdfjsLib.OPS.lineTo) {
                        currentPath += `L ${args[0]} ${args[1]} `;
                    }
                    else if (fn === pdfjsLib.OPS.curveTo) {
                        currentPath += `C ${args[0]} ${args[1]} ${args[2]} ${args[3]} ${args[4]} ${args[5]} `;
                    }
                    else if (fn === pdfjsLib.OPS.closePath) {
                        currentPath += `Z `;
                    }
                    else if (fn === pdfjsLib.OPS.rectangle) {
                        currentPath += `M ${args[0]} ${args[1]} L ${args[0] + args[2]} ${args[1]} L ${args[0] + args[2]} ${args[1] + args[3]} L ${args[0]} ${args[1] + args[3]} Z `;
                    }
                    // Painting (Fill/Stroke)
                    else if (fn === pdfjsLib.OPS.fill || fn === pdfjsLib.OPS.eoFill) {
                        if (currentPath) {
                            nativePaths.push({
                                d: currentPath,
                                fill: { ...fillColor },
                                opacity,
                                transform: [...currentMatrix]
                            });
                            currentPath = ""; // Path is consumed
                        }
                    }
                    else if (fn === pdfjsLib.OPS.stroke) {
                        if (currentPath) {
                            nativePaths.push({
                                d: currentPath,
                                stroke: { ...strokeColor, width: lineWidth },
                                opacity,
                                transform: [...currentMatrix]
                            });
                            currentPath = "";
                        }
                    }
                    else if (fn === pdfjsLib.OPS.fillStroke || fn === pdfjsLib.OPS.eoFillStroke) {
                        if (currentPath) {
                            nativePaths.push({
                                d: currentPath,
                                fill: { ...fillColor },
                                stroke: { ...strokeColor, width: lineWidth },
                                opacity,
                                transform: [...currentMatrix]
                            });
                            currentPath = "";
                        }
                    }
                    else if (fn === pdfjsLib.OPS.endPath) {
                        currentPath = "";
                    }
                }
            } catch (e) {
                console.warn("Native Path Extraction failed", e);
            }

            // 6. Extract Hyperlinks
            const links: Array<{ x: number, y: number, w: number, h: number, url: string }> = [];
            try {
                const annotations = await page.getAnnotations({ intent: 'display' });
                for (const annot of annotations) {
                    if (annot.subtype === 'Link' && annot.url && annot.rect) {
                        // annot.rect is [xLo, yLo, xHi, yHi] in PDF PDF coordinates (bottom-up)
                        // We need to convert to Viewport coordinates (which matches our item positions)
                        const rect = viewport.convertToViewportRectangle(annot.rect);
                        // Viewport rect is [xMin, yMin, xMax, yMax] (top-down usually, but let's normalize)
                        // Actually convertToViewportRectangle returns [xMin, yMin, xMax, yMax]
                        const x = Math.min(rect[0], rect[2]);
                        const y = Math.min(rect[1], rect[3]);
                        const w = Math.abs(rect[2] - rect[0]);
                        const h = Math.abs(rect[3] - rect[1]);

                        links.push({ x, y, w, h, url: annot.url });
                    }
                }
            } catch (e) {
                console.warn("Link extraction failed", e);
            }

            return {
                width: viewport.width,
                height: viewport.height,
                items: paragraphs,
                links,
                svg: svgString,
                svgSanitized: svgSanitizedString,
                svgUltraSafe: svgUltraSafeString,
                image: imageBytes,
                extractedImages: extractedImages,
                nativePaths: nativePaths,
                fonts: Array.from(uniqueFonts)
            };
        } finally {
            console.warn = originalWarn;
        }
    }
}
