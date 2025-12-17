import * as pdfjsLib from 'pdfjs-dist';
import { groupTextItems, Paragraph, TextItem } from './paragraph-grouper';

// Set worker source to CDN for simplicity in Figma plugin environment (avoids complex vite worker bundling)
// In a production app you might want to bundle this, but for this plugin CDN is reliable enough.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

export interface PageData {
    width: number;
    height: number;
    items: Paragraph[]; // Changed to Paragraphs
    svg?: string; // Vector content
    image?: Uint8Array; // Raster fallback
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
        // styles is a property of textContent containing font info key-value pairs
        const styles = textContent.styles;

        const rawItems: TextItem[] = [];
        for (const item of textContent.items as any[]) {
            // Resolve font data
            let fontData = { name: 'Inter', weight: 400, italic: false };
            if (item.fontName) {
                try {
                    const styleObj = styles[item.fontName];
                    if (styleObj) {
                        fontData.name = styleObj.fontFamily;
                        // basic heuristic for weight
                        if (styleObj.fontFamily.toLowerCase().includes('bold')) fontData.weight = 700;
                        if (styleObj.fontFamily.toLowerCase().includes('medium')) fontData.weight = 500;
                        // italics
                        fontData.italic = styleObj.fontFamily.toLowerCase().includes('italic');
                    }
                } catch (e) {
                    // fallback
                }
            }

            // Calculate font size from transform (scaleY)
            // transform: [scaleX, skewX, skewY, scaleY, x, y]
            const tx = item.transform;
            const fontSize = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);

            rawItems.push({
                type: 'text',
                str: item.str,
                x: tx[4],
                y: tx[5],
                fontSize: Math.round(fontSize),
                fontFamily: fontData.name,
                fontWeight: fontData.weight,
                isItalic: fontData.italic,
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
        try {
            const operatorList = await page.getOperatorList();
            const svgGraphics = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
            const svgElement = (await svgGraphics.getSVG(operatorList, viewport)) as unknown as SVGElement;
            svgString = svgElement.outerHTML;
        } catch (e) {
            console.warn("SVG Extraction failed, falling back to raster image only.", e);
        }

        return {
            width: viewport.width,
            height: viewport.height,
            items: paragraphs,
            svg: svgString,
            image: imageBytes
        };
    }
}
