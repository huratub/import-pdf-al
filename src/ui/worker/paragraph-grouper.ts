export interface TextItem {
    type: 'text';
    str: string;
    x: number;
    y: number; // PDF Coordinate (bottom-left)
    width: number;
    height: number;
    fontSize: number;
    fontFamily: string;
    fontName: string; // Internal ID (e.g. "g_d0_f1")
    rawFontName?: string; // Real PostScript name (e.g. "Arial-Bold")
    fontWeight: string | number; // allow 'bold' or numeric
    fontStyle: string; // 'italic', 'normal'
    color?: string; // New: Hex/RGB string
    opacity?: number; // Fill opacity
    mcid?: number; // Marked Content ID for structural mapping
    structRole?: string; // e.g. "H1", "P", "L"
    stroke?: {
        color: string;
        width: number;
        opacity: number;
    };
    letterSpacing?: number; // In pixels
    lineHeight?: number; // In pixels
    wordSpacing?: number; // Tw
    horizontalScaling?: number; // Tz (percentage)
    textRise?: number; // Ts
    textRenderMode?: number; // Tr
    matrix: number[]; // Full 6-element matrix [a, b, c, d, tx, ty]
    isRTL?: boolean;
    hasClip?: boolean;
    transform: number[]; // Keep original transform for ref
}

export interface Paragraph {
    type: 'paragraph';
    text: string;
    lines: TextItem[][]; // Array of lines (each line is array of items)
    x: number;
    y: number;
    width: number;
    height: number; // Computed height
    fontSize: number;
    opacity?: number;
    rawFontName?: string;
    mcid?: number; // Marked Content ID for structural mapping
    structRole?: string; // e.g. "H1", "P", "L"
    fontFamily: string;
    fontWeight: string | number;
    fontStyle: string;
    color?: string; // New
    letterSpacing?: number;
    lineHeight?: number;
    textAlign?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
}

export function groupTextItems(items: TextItem[]): Paragraph[] {
    if (items.length === 0) return [];

    // Sort items by Y (descending for PDF bottom-up coords) then X (ascending)
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
            currentPara = createNewParagraph(item);
            lastItem = item;
            continue;
        }

        // HEURISTICS for Grouping

        // 1. Same Line Check
        const verticalTolerance = Math.max(1, item.fontSize * 0.1);
        const sameLine = Math.abs(item.y - (lastItem?.y || 0)) < verticalTolerance;

        // 2. Style Compatibility
        const isCompatible =
            item.fontFamily === currentPara.fontFamily &&
            Math.abs(item.fontSize - currentPara.fontSize) < 1 &&
            item.fontWeight === currentPara.fontWeight &&
            item.fontStyle === currentPara.fontStyle &&
            item.color === currentPara.color;

        // 3. Column Detection
        const horizontalGap = item.x - ((lastItem?.x || 0) + (lastItem?.width || 0));
        const isFarApart = horizontalGap > (item.fontSize * 3);

        if (sameLine && isCompatible && !isFarApart) {
            // A) Append to current line
            currentPara.text += (item.str.startsWith(' ') ? '' : ' ') + item.str;
            const currentRight = item.x + item.width;
            const startX = currentPara.x;
            currentPara.width = Math.max(currentPara.width, currentRight - startX);

            // Update active line array
            currentPara.lines[currentPara.lines.length - 1].push(item);
            lastItem = item;

        } else if (isCompatible && isVerticallyConsecutive(currentPara, item, lastItem!)) {
            // B) Next Line (Vertical Merge in same paragraph)
            currentPara.text += ' ' + item.str; // Simple space join

            // Update width if this new line is wider
            currentPara.width = Math.max(currentPara.width, item.width);

            // Add new line array
            currentPara.lines.push([item]);
            lastItem = item;

        } else {
            // End current paragraph and start new one
            paragraphs.push(currentPara);
            currentPara = createNewParagraph(item);
            lastItem = item;
        }
    }

    if (currentPara) {
        paragraphs.push(currentPara);
    }

    console.log(`[PDFProcessor] Extracted ${paragraphs.length} paragraphs from ${items.length} raw text items.`);

    // Post-Processing: Calculate Alignment, Line Height
    for (const para of paragraphs) {
        if (para.lines.length > 1) {
            // Calculate Average Line Height (Y delta)
            let totalYDiff = 0;
            let diffCount = 0;
            for (let i = 0; i < para.lines.length - 1; i++) {
                // Compare Y of first item in line i vs line i+1
                // PDF Y is bottom-up: line[i].y > line[i+1].y
                // We use representative Y from first item of each line
                const l1 = para.lines[i][0];
                const l2 = para.lines[i + 1][0];
                const diff = l1.y - l2.y;
                if (diff > 0) {
                    totalYDiff += diff;
                    diffCount++;
                }
            }
            if (diffCount > 0) {
                para.lineHeight = totalYDiff / diffCount;
            }

            // Detect Alignment
            let isCentered = true;
            let isRight = true;
            // let isJustified = true;

            for (const line of para.lines) {
                const first = line[0];
                const last = line[line.length - 1];
                const lineWidth = (last.x + last.width) - first.x;
                const lineLeft = first.x;
                const lineRight = last.x + last.width;
                const paraRight = para.x + para.width;

                // Check Left (Default)
                // if (Math.abs(lineLeft - para.x) > 5) {}

                // Check Center
                const centerOffset = (para.width - lineWidth) / 2;
                const actualOffset = lineLeft - para.x;
                if (Math.abs(centerOffset - actualOffset) > 5) isCentered = false;

                // Check Right
                if (Math.abs(paraRight - lineRight) > 5) isRight = false;
            }

            if (isCentered) para.textAlign = 'CENTER';
            else if (isRight) para.textAlign = 'RIGHT';
            else para.textAlign = 'LEFT';
        }
    }

    return paragraphs;
}

// Helpers

function createNewParagraph(item: TextItem): Paragraph {
    return {
        type: 'paragraph',
        text: item.str,
        lines: [[item]],
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        fontSize: item.fontSize,
        fontFamily: item.fontFamily,
        fontWeight: item.fontWeight,
        fontStyle: item.fontStyle,
        color: item.color,
        opacity: item.opacity || 1,
        rawFontName: item.rawFontName,
        structRole: item.structRole,
        mcid: item.mcid,
        letterSpacing: item.letterSpacing,
        lineHeight: item.lineHeight
    };
}

function isVerticallyConsecutive(prev: Paragraph, next: TextItem, lastItem: TextItem): boolean {
    // 1. Vertical Distance Check
    const lastLineIndex = prev.lines.length - 1;
    const lastLineItems = prev.lines[lastLineIndex];
    const lastItemInPara = lastLineItems[0];

    // PDF Y is Bottom-Up. prev (higher) > next (lower).
    const yDiff = lastItemInPara.y - next.y;

    const expectedHeight = prev.fontSize;
    // Expect positive diff (prev is above next)
    // Tolerance: 0.5em to 2.5em
    if (yDiff < expectedHeight * 0.5 || yDiff > expectedHeight * 2.5) return false;

    // 2. Alignment Check (Left Align Logic/Indent)
    // If next line starts *way* to the left or right, it might be a different column or sidebar?
    // But for a paragraph, indentation is possible.
    // If it differs by more than 2-3 characters (2 * fontSize), be careful.
    // Let's loosen strict x-check if it's "close enough" (indentation)
    if (Math.abs(prev.x - next.x) > prev.fontSize * 4) return false;

    // 3. Color Check (New) - CRITICAL for headers vs body
    // If the color changes, it's likely a new section.
    if (next.color !== lastItem.color) return false;

    // Structural Check: If they have different MCIDs, they are likely different semantic blocks
    if (next.mcid !== undefined && lastItem.mcid !== undefined && next.mcid !== lastItem.mcid) {
        return false;
    }

    return true;
}
