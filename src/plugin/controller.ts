// Main thread logic
figma.showUI(__html__, { width: 400, height: 600 });

figma.ui.onmessage = async (msg) => {
    if (msg.type === 'create-rectangles') {
        const nodes: SceneNode[] = [];
        for (let i = 0; i < msg.count; i++) {
            const rect = figma.createRectangle();
            rect.x = i * 150;
            rect.fills = [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0 } }];
            figma.currentPage.appendChild(rect);
            nodes.push(rect);
        }
        figma.currentPage.selection = nodes;
        figma.viewport.scrollAndZoomIntoView(nodes);
    }

    if (msg.type === 'create-page') {
        const { index, data } = msg; // data = { width, height, items }
        console.log(`[Controller] creating page ${index + 1}`, {
            width: data.width,
            height: data.height,
            itemCount: data.items.length,
            hasSVG: !!data.svg,
            hasSanitizedSVG: !!data.svgSanitized,
            hasImage: !!data.image,
            hasExtractedImages: data.extractedImages?.length,
            fontCount: data.fonts?.length
        });

        const frame = figma.createFrame();
        frame.name = `Page ${index + 1}`;
        frame.x = index * (data.width + 50); // layout horizontally
        frame.resizeWithoutConstraints(data.width, data.height);

        // Basic text rendering (MVP)
        // We need to load fonts first, but for now let's just create nodes
        // To strictly follow "await figma.loadFontAsync", we need a separate async function or handle it carefully.

        const processItems = async () => {
            // 1. Background Layer (Image or SVG)
            // If we have SVG, we try that (it's vector).
            // If we have Image, we put that BEHIND everything as a fallback/reference.
            // Ideally, the user chooses "Editable" (Vectors) or "Reference" (Image).
            // For now, we'll put the Image at the bottom (if exists) and SVG on top of it (if exists).

            if (data.image) {
                const imageRect = figma.createRectangle();
                imageRect.resize(data.width, data.height);
                imageRect.name = "Page Image (Background)";

                const imageHash = figma.createImage(data.image).hash;
                imageRect.fills = [{ type: 'IMAGE', scaleMode: 'FIT', imageHash }];

                frame.appendChild(imageRect);
                imageRect.locked = true; // Lock background
            }

            if (data.svg) {
                try {
                    // Pass A: High Fidelity SVG
                    const svgNode = figma.createNodeFromSvg(data.svg);
                    svgNode.name = "Vector Graphics (Hi-Fi)";
                    frame.appendChild(svgNode);
                } catch (e) {
                    console.warn("High fidelity SVG failed, trying fallback...", e);

                    // Pass B: Sanitized SVG
                    if (data.svgSanitized) {
                        try {
                            const sanitizedNode = figma.createNodeFromSvg(data.svgSanitized);
                            sanitizedNode.name = "Vector Graphics (Sanitized)";
                            frame.appendChild(sanitizedNode);
                        } catch (e2) {
                            console.warn("Sanitized SVG also failed, trying Ultra-Safe...", e2);

                            // Pass C: Ultra-Safe SVG
                            if (data.svgUltraSafe) {
                                try {
                                    const ultraSafeNode = figma.createNodeFromSvg(data.svgUltraSafe);
                                    ultraSafeNode.name = "Vector Graphics (Safe)";
                                    frame.appendChild(ultraSafeNode);
                                } catch (e3) {
                                    console.warn("All SVG fallbacks failed. Only Background Image will be shown.", e3);
                                }
                            }
                        }
                    }
                }
            }

            // 1.5 Render Smart Extracted Images (Background/Photos)
            // These are individual bitmaps extracted from the PDF stream.
            if (data.extractedImages && data.extractedImages.length > 0) {
                // Determine parent: frame
                const imageNodes: SceneNode[] = [];

                for (const imgData of data.extractedImages) {
                    try {
                        const image = figma.createImage(imgData.data);
                        const rect = figma.createRectangle();
                        rect.name = "Image";
                        rect.fills = [{ type: 'IMAGE', scaleMode: 'FIT', imageHash: image.hash }];

                        // Transform Mapping
                        // PDF Matrix: [a, b, c, d, tx, ty]
                        const [a, b, c, d, tx, ty] = imgData.transform;

                        // Scale
                        const width = Math.sqrt(a * a + b * b);
                        const height = Math.sqrt(c * c + d * d);

                        // Position (Assume unrotated/Bottom-Left origin)
                        const figmaX = tx;
                        const figmaY = data.height - ty - height;

                        rect.x = figmaX;
                        rect.y = figmaY;
                        rect.resize(width, height);

                        frame.appendChild(rect);
                        imageNodes.push(rect);
                    } catch (err) {
                        console.warn("Failed to render extracted image", err);
                    }
                }

                if (imageNodes.length > 0) {
                    const group = figma.group(imageNodes, frame);
                    group.name = "Images";
                }
            }

            // 1.7 Render Native Vectors
            if (data.nativePaths && data.nativePaths.length > 0) {
                // Determine nodes to group
                const vectorNodes: SceneNode[] = [];

                for (const pathData of data.nativePaths) {
                    try {
                        const vector = figma.createVector();
                        vector.vectorPaths = [{
                            data: pathData.d,
                            windingRule: 'NONZERO'
                        }];

                        if (pathData.fill) {
                            vector.fills = [{ type: 'SOLID', color: pathData.fill, opacity: pathData.opacity || 1 }];
                        } else {
                            vector.fills = [];
                        }

                        if (pathData.stroke) {
                            vector.strokes = [{ type: 'SOLID', color: { r: pathData.stroke.r, g: pathData.stroke.g, b: pathData.stroke.b }, opacity: pathData.opacity || 1 }];
                            vector.strokeWeight = pathData.stroke.width;
                        }

                        // Matrix Mapping (Experimental Flip)
                        const [a, b, c, d, tx, ty] = pathData.transform;
                        // PDF -> Figma (Flip Y)
                        // vector.x = tx; // This is naive
                        // vector.y = data.height - ty;

                        // Full matrix approach:
                        // Figma: [[a, c, tx], [b, d, ty]]
                        // PDF: [a, b, c, d, tx, ty]
                        // Note: Figma's matrix rows are [a, c, tx] and [b, d, ty]
                        // We need row-major for figma.relativeTransform
                        vector.relativeTransform = [
                            [a, c, tx],
                            [-b, -d, data.height - ty]
                        ];

                        vectorGroup.appendChild(vector);
                    } catch (err) {
                        console.warn("Failed to render native vector", err);
                    }
                }
            }

            // Create Text on top
            // We need to preload common fonts. In a real app we'd map PDF fonts to Figma fonts.
            // For MVP, we load Inter (Regular, Bold).
            // 2. Preload Fonts
            // We blindly try to load the fonts detected in the PDF.
            // If they fail, we fallback to Inter.
            const uniqueFontFamilies = new Set<string>(data.fonts || []);
            uniqueFontFamilies.add("Inter"); // Always needed for fallback

            const fontLoadPromises: Promise<void>[] = [];

            // Helper to get Figma Style Name from weight/style
            const getStyleName = (weight: string | number, style: string) => {
                const isBold = weight === 'bold' || (typeof weight === 'number' && weight >= 700);
                const isItalic = style === 'italic';
                if (isBold && isItalic) return "Bold Italic";
                if (isBold) return "Bold";
                if (isItalic) return "Italic";
                return "Regular";
            };

            // NEW: Clean PostScript Names
            // e.g. "ABCDEF+Roboto-Bold" -> { family: "Roboto", style: "Bold" }
            const cleanFontName = (psName: string) => {
                let name = psName;
                // Remove Subset prefix (6 chars + +)
                if (name.includes('+')) {
                    name = name.split('+')[1];
                }

                // Split by Hyphen
                let [family, style] = name.split('-');
                if (!style) style = "Regular";

                // Clean Style
                style = style.replace('MT', '').replace('PS', '').replace('Std', '').replace('Pro', '');
                // Basic mapping
                if (style === 'BoldMT') style = 'Bold';
                if (style === 'ItalicMT') style = 'Italic';

                // Clean Family
                family = family.replace('MT', '').replace('PS', '').replace('Std', '');
                // Space insertion for camelCase might be good but risky. "TimesNewRoman" -> "Times New Roman"
                if (family === 'TimesNewRoman') family = 'Times New Roman';
                if (family === 'ArialMT') family = 'Arial';

                return { family, style };
            };

            // We need to load specific {Family, Style} pairs.
            // Since we don't know exactly which combinations exist, let's load
            // the combinations we *see* in the items. 
            // Better: Iterate items and collect required {Family, Style} pairs.
            // Collect required fonts with preferred names
            const requiredFonts = new Set<string>(); // "Family|Style"

            data.items.forEach((item: any) => {
                const style = getStyleName(item.fontWeight, item.fontStyle);

                // 1. Prefer Raw PS Name
                if (item.rawFontName) {
                    const { family, style: psStyle } = cleanFontName(item.rawFontName);
                    requiredFonts.add(`${family}|${psStyle}`);
                    // Also try mixed combos
                    requiredFonts.add(`${family}|${style}`);
                }

                // 2. CSS Fallback (what we had before)
                requiredFonts.add(`${item.fontFamily}|${style}`);

                // 3. Fallback
                requiredFonts.add(`Inter|${style}`);
            });

            const loadedFonts = new Set<string>();
            const missingFonts = new Set<string>(); // Just for logging

            const loadFontSafe = async (family: string, style: string) => {
                const id = `${family}|${style}`;
                if (loadedFonts.has(id)) return true; // Already loaded
                try {
                    await figma.loadFontAsync({ family, style });
                    loadedFonts.add(id);
                    return true;
                } catch (e) {
                    // console.warn(`Failed to load ${family} ${style}`);
                    return false;
                }
            };

            // Execute Loading
            for (const fontId of requiredFonts) {
                const [family, style] = fontId.split('|');
                await loadFontSafe(family, style);
            }
            // Always load Inter Regular as last resort
            await loadFontSafe("Inter", "Regular");

            if (missingFonts.size > 0) {
                figma.notify(`Some fonts could not be loaded.`, { timeout: 2000 });
            }

            for (const item of data.items) {
                if (item.type === 'paragraph' && item.text.trim().length > 0) {
                    const text = figma.createText();
                    text.characters = item.text;

                    // Name layer based on role
                    if (item.structRole) {
                        text.name = `[${item.structRole}] ${item.text.substring(0, 20)}...`;
                    } else {
                        text.name = item.text.substring(0, 30);
                    }

                    // Style
                    text.fontSize = item.fontSize;

                    // Font Loading Logic
                    // Font Loading Logic - PRIORITY SEQUENCE
                    const styleName = getStyleName(item.fontWeight, item.fontStyle);
                    const cssFamily = item.fontFamily;

                    let chosenFont = { family: "Inter", style: "Regular" };

                    // 1. Try Cleaned PS Name
                    if (item.rawFontName) {
                        const { family, style } = cleanFontName(item.rawFontName);
                        if (loadedFonts.has(`${family}|${style}`)) {
                            chosenFont = { family, style };
                        } else if (loadedFonts.has(`${family}|${styleName}`)) {
                            chosenFont = { family, style: styleName };
                        }
                    }

                    // 2. Try CSS Family
                    if (chosenFont.family === "Inter") { // Only if not found yet
                        if (loadedFonts.has(`${cssFamily}|${styleName}`)) {
                            chosenFont = { family: cssFamily, style: styleName };
                        }
                    }

                    // 3. Try Inter w/ Style
                    if (chosenFont.family === "Inter") {
                        if (loadedFonts.has(`Inter|${styleName}`)) {
                            chosenFont = { family: "Inter", style: styleName };
                        }
                    }

                    text.fontName = chosenFont;

                    // Coordinate Mapping - TOP ALIGN APPROACH
                    // text.y = data.height - (item.y + item.height); 
                    text.x = item.x;
                    // Standard Baseline to Top conversion:
                    // Top = BaselineY + (0.8 * FontSize)
                    // FigmaY = PageHeight - Top
                    // FigmaY = PageHeight - (item.y + (item.fontSize * 0.9)); // Increased to 0.9 to push it up (prevent overlap below)

                    text.y = data.height - item.y - (item.fontSize * 0.95);

                    // Box Control
                    if (item.lines && item.lines.length > 1) {
                        // Multi-line Paragraph -> Fixed Width / Auto Height
                        text.textAutoResize = "HEIGHT";
                        text.resize(item.width, item.fontSize * item.lines.length * 1.2); // Initial height guess
                    } else {
                        // Single Line -> Point Text (Auto Width)
                        text.textAutoResize = "WIDTH_AND_HEIGHT";
                    }

                    // Layout Fidelity Improvements
                    // 0. Alignment (New)
                    if (item.textAlign) {
                        text.textAlignHorizontal = item.textAlign;
                    }

                    // 1. Line Height
                    // Priority: Calculated (PDF Y-delta) > CSS Computed > Auto
                    if (item.lineHeight) {
                        text.lineHeight = { value: item.lineHeight, unit: 'PIXELS' };
                    }

                    // 2. Letter Spacing
                    // Computed style gives px. Figma uses pixels (or %).
                    if (item.letterSpacing) {
                        text.letterSpacing = { value: item.letterSpacing, unit: 'PIXELS' };
                    } else {
                        // Default tight tracking if none found 
                        text.letterSpacing = { value: -0.5, unit: 'PERCENT' };
                    }

                    // 3. Color & Opacity
                    // We need to parse color string and apply opacity
                    const fills: SolidPaint[] = [];
                    if (item.color) {
                        try {
                            const rgbMatch = item.color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                            if (rgbMatch) {
                                const r = parseInt(rgbMatch[1]) / 255;
                                const g = parseInt(rgbMatch[2]) / 255;
                                const b = parseInt(rgbMatch[3]) / 255;
                                fills.push({
                                    type: 'SOLID',
                                    color: { r, g, b },
                                    opacity: item.opacity !== undefined ? item.opacity : 1
                                });
                            }
                        } catch (e) {
                            // Keep default
                            fills.push({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } });
                        }
                    } else {
                        fills.push({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } });
                    }
                    text.fills = fills;

                    // 4. Strokes
                    if (item.stroke) {
                        try {
                            const strokeRgb = item.stroke.color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                            if (strokeRgb) {
                                const r = parseInt(strokeRgb[1]) / 255;
                                const g = parseInt(strokeRgb[2]) / 255;
                                const b = parseInt(strokeRgb[3]) / 255;
                                text.strokes = [{
                                    type: 'SOLID',
                                    color: { r, g, b },
                                    opacity: item.stroke.opacity
                                }];
                                text.strokeWeight = item.stroke.width;
                            }
                        } catch (e) {
                            console.warn("Stroke parsing failed", e);
                        }
                    }

                    frame.appendChild(text);
                }
            }
        };

        processItems().catch(e => console.error("Item creation failed", e));
        figma.currentPage.appendChild(frame);
        figma.viewport.scrollAndZoomIntoView([frame]);
    }

    if (msg.type === 'cancel') {
        figma.closePlugin();
    }
};
