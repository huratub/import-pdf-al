export interface TextItem {
    type: 'text';
    str: string;
    x: number;
    y: number; // PDF Coordinate (bottom-left)
    width: number;
    height: number;
    fontSize: number;
    fontFamily: string;
    fontWeight: string | number; // allow 'bold' or numeric
    fontStyle: string; // 'italic', 'normal'
    color?: string; // New: Hex/RGB string
    letterSpacing?: number; // In pixels
    lineHeight?: number; // In pixels
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
    fontWeight: string | number;
    fontStyle: string;
    color?: string; // New
    letterSpacing?: number;
    lineHeight?: number;
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
                fontStyle: item.fontStyle,
                color: item.color,
                letterSpacing: item.letterSpacing,
                lineHeight: item.lineHeight
            };
            lastItem = item;
            continue;
        }

        // HEURISTICS for Grouping
        // 1. Same Line Check (Critical for "03 Title" case)
        // Groups items that are visually on the same baseline.
        const verticalTolerance = Math.max(2, item.fontSize * 0.25);
        const sameLine = Math.abs(item.y - (lastItem?.y || 0)) < verticalTolerance;

        // 2. Style Compatibility
        // We relax style check if it's the SAME LINE to allow "<b>Bold</b> Regular" headers to merge 
        // OR "03 Title" where 03 might be different style/color.
        // User request: "Never split '03' across lines".
        // Use loose check for same line, stricter for next line.
        let isCompatible =
            item.fontFamily === currentPara.fontFamily &&
            Math.abs(item.fontSize - currentPara.fontSize) < 2 && // Allow small size variation on same line
            item.fontWeight === currentPara.fontWeight &&
            item.fontStyle === currentPara.fontStyle &&
            item.color === currentPara.color;

        // If on same line, we might merge even if styles differ slightly? 
        // Actually, Figma TextNode can't handle mixed styles in one node purely via createText(). 
        // But breaking them splits the flow. 
        // User wants "Keep grouping".
        // If we split, we get two text nodes. 
        // If we merge, we lose mixed style fidelity unless we implement Mixed Style setters (Phase X).
        // For now, let's Stick to "Split on Style Change" BUT ensure they align horizontally?
        // Wait, current issue is "Splitting weirdly". If '03' is same style as 'Title', why split?
        // Maybe the 'width' calculation or space insertion was wrong. 
        // Or maybe they ARE different styles.
        // If different styles, we MUST split in current architecture.
        // But if they are same style, they should merge.
        // Let's assume they are same style for now, or ensure 'sameLine' logic captures them.

        // 3. Vertical Proximity (Next Line in Paragraph)
        const verticalGap = (lastItem?.y || 0) - item.y;
        const isNextLine = verticalGap > 0 && verticalGap < (item.fontSize * 2.5); // Max gap
        const alignedLeft = Math.abs(item.x - currentPara.x) < 20;

        let shouldMerge = isCompatible; // Default to style compatibility

        if (sameLine) {
            // For same line, we are more lenient with style differences if it's a list marker scenario.
            // If the previous item was very short (potential list marker) and there's a significant gap,
            // we might still want to merge if the styles are "close enough" or if it's a common pattern.
            // For now, we rely on `isCompatible` but ensure the horizontal gap isn't too large.
            const horizontalGap = item.x - ((lastItem?.x || 0) + (lastItem?.width || 0));
            if (horizontalGap > 100) { // Arbitrary threshold for separate columns
                shouldMerge = false;
            }
        } else if (isNextLine && alignedLeft) {
            // For next line, we require style compatibility.
            shouldMerge = isCompatible;
        } else {
            shouldMerge = false; // Neither same line nor next line with alignment
        }

        if (shouldMerge) {
            // Append to current paragraph
            if (sameLine) {
                // Check horizontal gap. If huge gap, maybe separate columns?
                // But for "03    Title", it's a list. We want one node? 
                // Or separate nodes? "Keep list marker + first line together" implies one flow or tight grouping.
                // If we merge, we separate with space.
                // The horizontalGap check is now part of `shouldMerge` determination.
                currentPara.text += (item.str.startsWith(' ') ? '' : ' ') + item.str;
                const currentRight = item.x + item.width;
                const startX = currentPara.x;
                currentPara.width = Math.max(currentPara.width, currentRight - startX);
            } else {
                // New Line
                currentPara.text += (item.str.startsWith(' ') ? '' : ' ') + item.str;
                currentPara.width = Math.max(currentPara.width, item.width);
            }
            lastItem = item;
        } else {
            // End current
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
                fontStyle: item.fontStyle,
                color: item.color,
                letterSpacing: item.letterSpacing,
                lineHeight: item.lineHeight
            };
            lastItem = item;
        }
    }

    if (currentPara) {
        paragraphs.push(currentPara);
    }

    return paragraphs;
}
