export interface TextItem {
    type: 'text';
    str: string;
    x: number;
    y: number; // PDF Coordinate (bottom-left)
    width: number;
    height: number;
    fontSize: number;
    fontFamily: string;
    fontWeight: number;
    isItalic: boolean;
    transform: number[];
}

export interface Paragraph {
    type: 'paragraph';
    text: string;
    x: number;
    y: number;
    width: number;
    fontSize: number;
    fontFamily: string;
    fontWeight: number;
    isItalic: boolean;
    lineHeight: number;
}

export function groupTextItems(items: TextItem[]): Paragraph[] {
    if (items.length === 0) return [];

    // Sort items by Y (descending for PDF bottom-up coords) then X (ascending)
    // In PDF, higher Y is higher up on the page.
    const sorted = [...items].sort((a, b) => {
        const yDiff = b.y - a.y;
        if (Math.abs(yDiff) > 5) return yDiff; // Significant Y difference
        return a.x - b.x; // Same line, sort left to right
    });

    const paragraphs: Paragraph[] = [];
    let currentPara: Paragraph | null = null;
    let lastItem: TextItem | null = null;

    for (const item of sorted) {
        if (!item.str.trim()) continue; // Skip empty whitespace items

        if (!currentPara) {
            // Start new paragraph
            currentPara = {
                type: 'paragraph',
                text: item.str,
                x: item.x,
                y: item.y,
                width: item.width, // Initial width
                fontSize: item.fontSize,
                fontFamily: item.fontFamily,
                fontWeight: item.fontWeight,
                isItalic: item.isItalic,
                lineHeight: item.fontSize * 1.2
            };
            lastItem = item;
            continue;
        }

        // HEURISTICS for Grouping
        // 1. Same Stylings
        const sameStyle =
            item.fontFamily === currentPara.fontFamily &&
            Math.abs(item.fontSize - currentPara.fontSize) < 1 &&
            item.fontWeight === currentPara.fontWeight &&
            item.isItalic === currentPara.isItalic;

        // 2. Vertical Proximity (Line Spacing)
        // PDF Y is bottom-up. Next line has LOWER Y.
        // Difference should be positive (lastItem!.y - item.y)
        const verticalGap = (lastItem?.y || 0) - item.y; // Safe access
        const isNextLine = verticalGap > 0 && verticalGap < (item.fontSize * 2.5); // Max 2.5x line height gap

        // 3. Horizontal Alignment (roughly same Left align)
        // Loosen horizontal alignment slightly to handle hanging punctuation or minor drifts
        // But stricter than "separate column". 
        const alignedLeft = Math.abs(item.x - currentPara.x) < 20;

        // 4. Same Line (continuation)
        const sameLine = Math.abs(item.y - (lastItem?.y || 0)) < 2; // Tolerance for float errors

        if (sameStyle && ((isNextLine && alignedLeft) || sameLine)) {
            // Append to current paragraph
            if (sameLine) {
                // Add space if needed? PDF text chunks sometimes omit spaces if positioned explicitly
                // Simple heuristic: if gap > charWidth/2, add space.
                // For now, just add space if not present.
                currentPara.text += (item.str.startsWith(' ') ? '' : ' ') + item.str;
                // Update width: Current line extends further?
                // Since we don't track the "cursor x" easily for the aggregated line without font metrics,
                // we just sum widths roughly for same-line appends. 
                // A better approach for "same line" is item.x + item.width - currentPara.x
                const currentRight = item.x + item.width;
                const startX = currentPara.x;
                currentPara.width = Math.max(currentPara.width, currentRight - startX);
            } else {
                // New Line
                currentPara.text += '\n' + item.str;
                // Update Layout Width: This line might be wider than the first line
                // item.width is the width of this new chunk. 
                // Since alignedLeft is true, item.x is roughly currentPara.x
                // So effective width is approx item.width.
                // We take the max of known widths to define the bounding box.
                currentPara.width = Math.max(currentPara.width, item.width);
            }
            lastItem = item;
        } else {
            // End current, start new
            paragraphs.push(currentPara);
            currentPara = {
                type: 'paragraph',
                text: item.str,
                x: item.x,
                y: item.y,
                width: item.width,
                fontSize: item.fontSize,
                fontFamily: item.fontFamily,
                fontWeight: item.fontWeight,
                isItalic: item.isItalic,
                lineHeight: item.fontSize * 1.2
            };
            lastItem = item;
        }
    }

    if (currentPara) {
        paragraphs.push(currentPara);
    }

    return paragraphs;
}
