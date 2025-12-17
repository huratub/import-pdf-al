import * as pdfjsLib from 'pdfjs-dist';
import { groupTextItems, Paragraph, TextItem } from './paragraph-grouper';

// Set worker source to CDN for simplicity in Figma plugin environment (avoids complex vite worker bundling)
// In a production app you might want to bundle this, but for this plugin CDN is reliable enough.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

export interface PageData {
    width: number;
    height: number;
    items: Paragraph[];
    links?: Array<{ x: number, y: number, w: number, h: number, url: string }>;
    svg?: string;
    svgSanitized?: string;
    image?: Uint8Array;
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

        // Pages are 1-indexed in PDF.js
        const page = await this.pdf.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 1.0 });

        // 1. Extract Text
        const textContent = await page.getTextContent();

        // Use RenderTextLayer to extract correct styles (Color, Bold, Italic) from CSS
        const styleMap = new Map<number, {
            color: string,
            weight: string | number,
            style: string,
            family: string,
            fontSize: number,
            lineHeight: number,
            letterSpacing: number
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

                    const family = cs.fontFamily ? cs.fontFamily.replace(/['"]/g, '') : 'Inter';
                    uniqueFonts.add(family);

                    styleMap.set(index, {
                        color: cs.color || 'rgb(0,0,0)',
                        weight: cs.fontWeight || '400',
                        style: cs.fontStyle || 'normal',
                        family: family,
                        fontSize: fontSizePx,
                        lineHeight: lineHeightPx,
                        letterSpacing: letterSpacingPx
                    });
                });
            }
            document.body.removeChild(container);
        } catch (e) {
            console.warn("Text Layer style extraction failed", e);
        }

        const rawItems: TextItem[] = [];
        const items = textContent.items as any[];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const domStyles = styleMap.get(i);

            // Fallbacks
            let weight: string | number = 400;
            let fontStyle = 'normal';
            let color = domStyles?.color || 'rgb(0, 0, 0)';
            let fontFamily = 'Inter';
            let extractedFontSize = 0;
            let extractedLineHeight = 0;
            let extractedLetterSpacing = 0;

            if (domStyles) {
                weight = domStyles.weight;
                fontStyle = domStyles.style;
                fontFamily = domStyles.family;
                extractedFontSize = domStyles.fontSize;
                extractedLineHeight = domStyles.lineHeight;
                extractedLetterSpacing = domStyles.letterSpacing;
            }

            // Calculate geometric font size as backup or verification
            const tx = item.transform;
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

                // Remove PostScript suffixes if needed or just trust the raw name and let Controller fallback
                // User requirement: "Match installed font by PostScript name first"
                // We pass the raw name, Controller handles fallback.
            }

            // Metric Precision: User wants "Exact px value", "Never round aggressively"
            // We have two sources:
            // 1. geoFontSize: from PDF transformation matrix (The "Mathematical" size)
            // 2. extractedFontSize: from CSS computed style (The "Rendered" size)
            // PDF.js text layer makes CSS match the visual size. 
            // We should use the CSS value if it exists and is non-zero, as it accounts for scaling.
            let finalFontSize = extractedFontSize > 0 ? extractedFontSize : geoFontSize;

            // Allow checking geometry if CSS failed
            if (finalFontSize === 0) finalFontSize = 12; // safety fallback

            rawItems.push({
                type: 'text',
                str: item.str,
                x: tx[4],
                y: tx[5],
                fontSize: finalFontSize, // FLOAT, do not round
                fontFamily: fontFamily,
                fontWeight: weight,
                fontStyle: fontStyle,
                color: color,
                lineHeight: extractedLineHeight, // FLOAT
                letterSpacing: extractedLetterSpacing, // FLOAT
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
        try {
            try {
                const operatorList = await page.getOperatorList();
                const svgGraphics = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
                const svgElement = (await svgGraphics.getSVG(operatorList, viewport)) as unknown as SVGElement;
                svgString = svgElement.outerHTML;
            } catch (e) {
                console.warn("SVG Extraction (High Fidelity) crashed inside PDF.js - skipping vector layer.", e);
                // Ensure we don't pass null/garbage
                svgString = '';
            }

            // Pass B: Sanitized SVG (Clone and Strip)
            try {
                const clone = svgElement.cloneNode(true) as SVGElement;

                // Remove Figma-breaking tags but KEEP Gradients (linearGradient, radialGradient, stops)
                // We typically find gradients in <defs>.
                const badTags = ['filter', 'mask', 'clipPath', 'foreignObject', 'symbol', 'image', 'marker', 'pattern'];
                // Note: stripping 'image' prevents nested rasters in SVG which Figma hates from PDF.js output.
                // Keeping 'use' might be okay if it references a shape, but often references a symbol/mask.
                // Let's ideally strip 'use' if it points to a deleted ID, but that's hard. 
                // Safer to strip 'use' if we want "Simple Shapes".

                badTags.forEach(tag => {
                    const elements = clone.querySelectorAll(tag);
                    elements.forEach(el => el.remove());
                });

                // Remove problematic attributes
                const allElements = clone.querySelectorAll('*');
                allElements.forEach(el => {
                    el.removeAttribute('filter');
                    el.removeAttribute('mask');
                    el.removeAttribute('clip-path');
                    // el.removeAttribute('mix-blend-mode'); // Figma supports some blends, but often they conflict.
                    // If we remove mix-blend-mode, we lose "Multiply".
                    // The user wants Blend Modes.
                    // Let's KEEP mix-blend-mode for the sanitized version? 
                    // Or maybe specifically map it? SVG import in Figma respects standard blend modes.
                    // Let's try KEEPING it in the "Sanitized" version if it's a standard one.

                    // Clear opacity on groups if it's effectively 0 ?
                });

                svgSanitizedString = clone.outerHTML;

                svgSanitizedString = clone.outerHTML;
            } catch (e) {
                console.warn("SVG Sanitization failed", e);
            }

        } catch (e) {
            console.warn("SVG Extraction failed, falling back to raster image only.", e);
        }

        // 5. Extract Hyperlinks
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
            image: imageBytes,
            fonts: Array.from(uniqueFonts)
        };
    }
}
