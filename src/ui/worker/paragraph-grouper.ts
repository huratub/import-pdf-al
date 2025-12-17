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
                width: item.width,
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
        const alignedLeft = Math.abs(item.x - currentPara.x) < 10;

        // 4. Same Line (continuation)
        const sameLine = Math.abs(item.y - (lastItem?.y || 0)) < 2; // Tolerance for float errors

        if (sameStyle && ((isNextLine && alignedLeft) || sameLine)) {
            // Append to current paragraph
            if (sameLine) {
                // Add space if needed? PDF text chunks sometimes omit spaces if positioned explicitly
                // Simple heuristic: if gap > charWidth/2, add space.
                // For now, just add space if not present.
                currentPara.text += (item.str.startsWith(' ') ? '' : ' ') + item.str;
                currentPara.width += item.width; // Rough approx
            } else {
                // New Line
                currentPara.text += '\n' + item.str;
                // Update Y to match the top-most line? No, Y usually denotes the start position.
                // Keep the Y of the first line as the Paragraph Y for Figma (Top-Left) logic later.
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
