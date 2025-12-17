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
    lines: TextItem[][]; // Array of lines (each line is array of items)
    x: number;
    y: number;
    width: number;
    height: number; // Computed height
    fontSize: number;
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
    // In PDF, higher Y is higher up on the page.
    const sorted = [...items].sort((a, b) => {
        const yDiff = b.y - a.y;
        if (Math.abs(yDiff) > 5) return yDiff; // Significant Y difference
        return a.x - b.x; // Same line, sort left to right
    });

    const paragraphs: Paragraph[] = [];
    let currentPara: Paragraph | null = null;
    let lastItem: TextItem | null = null;
    let currentLine: TextItem[] = [];

    for (const item of sorted) {
        if (!item.str.trim()) continue; // Skip empty whitespace items

        if (!currentPara) {
            // Start new paragraph
            currentLine = [item];
            currentPara = {
                type: 'paragraph',
                text: item.str,
                lines: [currentLine],
                x: item.x,
                y: item.y,
                width: item.width, // Initial width
                height: item.height, // Initial
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

                // Update active line array
                currentPara.lines[currentPara.lines.length - 1].push(item);
            } else {
                // New Line
                currentPara.text += (item.str.startsWith(' ') ? '' : ' ') + item.str;
                currentPara.width = Math.max(currentPara.width, item.width);
                currentPara.lines.push([item]);
            }
            lastItem = item;
        } else {
            // End current
            paragraphs.push(currentPara);
            currentLine = [item];
            currentPara = {
                type: 'paragraph',
                text: item.str,
                lines: [currentLine],
                x: item.x,
                y: item.y,
                width: item.width,
                height: item.height,
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

    console.log(`[PDFProcessor] Extracted ${paragraphs.length} paragraphs from ${items.length} raw text items.`);

    if (currentPara) {
        paragraphs.push(currentPara);
    }

    // Post-Processing: Calculate Alignment, Line Height, and refined Width
    for (const para of paragraphs) {
        // We need to re-analyze the lines within the paragraph text? 
        // Actually, we lost the individual line positions in the simple string concatenation.
        // To do this accurately strictly for "Competitor Level", we should have stored the 'lines' in the paragraph.
        // Refactoring Paragraph to store 'lines' is risky right now but necessary for Alignment/LineHeight.
        // ALTERNATIVE: Use the data we have.
        // We have 'height' of the bounding box? No, we have width. height is unknown (auto).

        // Let's rely on basic heuristics or stick to "Left" if we can't be sure?
        // User wants "1.8 Text Alignment".
        // To detect alignment, we need to know the x-start of each line relative to the paragraph bounds.
        // Since we flattened to string, we can't do this PERFECTLY on the 'paragraphs' array alone without rewriting the grouper to store lines.

        // DECISION: Rewrite Grouper to accumulate `lines: TextItem[]` instead of just string.
        // This allows correct Line Height calc (avg delta y) and Alignment.
        if (para.lines.length > 1) {
            // Calculate Average Line Height (Y delta)
            let totalYDiff = 0;
            let diffCount = 0;
            for (let i = 0; i < para.lines.length - 1; i++) {
                // Compare Y of first item in line i vs line i+1
                const l1 = para.lines[i][0];
                const l2 = para.lines[i + 1][0];
                const diff = l1.y - l2.y; // PDF Y is bottom-up, so top line > bottom line
                if (diff > 0) {
                    totalYDiff += diff;
                    diffCount++;
                }
            }
            if (diffCount > 0) {
                para.lineHeight = totalYDiff / diffCount;
            }

            // Detect Alignment
            // Check start positions and end positions relative to bbox
            // Left: all starts roughly same (para.x)
            // Center: (bbox.width - line.width) / 2 approx equal to line.x - para.x
            // Right: all ends roughly same (para.right)

            let isCentered = true;
            let isRight = true;
            let isJustified = true; // Harder to detect without strict bounds

            for (const line of para.lines) {
                const first = line[0];
                const last = line[line.length - 1];
                const lineWidth = (last.x + last.width) - first.x;
                const lineLeft = first.x;
                const lineRight = last.x + last.width;
                const paraRight = para.x + para.width;

                // Check Left (Default) - if variance > threshold, not left
                if (Math.abs(lineLeft - para.x) > 5) {
                    // Not strictly left aligned
                }

                // Check Center
                const centerOffset = (para.width - lineWidth) / 2;
                const actualOffset = lineLeft - para.x;
                if (Math.abs(centerOffset - actualOffset) > 5) isCentered = false;

                // Check Right
                if (Math.abs(paraRight - lineRight) > 5) isRight = false;
            }

            if (isCentered) para.textAlign = 'CENTER';
            else if (isRight) para.textAlign = 'RIGHT';
            else para.textAlign = 'LEFT'; // Fallback
        }
    }

    return paragraphs;
}
