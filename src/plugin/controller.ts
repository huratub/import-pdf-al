// Main thread logic
figma.showUI(__html__, { width: 400, height: 600 });

figma.ui.onmessage = (msg) => {
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
                            console.error("Sanitized SVG also failed", e2);
                        }
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

            // We need to load specific {Family, Style} pairs.
            // Since we don't know exactly which combinations exist, let's load
            // the combinations we *see* in the items. 
            // Better: Iterate items and collect required {Family, Style} pairs.
            const requiredFonts = new Set<string>(); // "Family|Style"
            data.items.forEach((item: any) => {
                const style = getStyleName(item.fontWeight, item.fontStyle);
                requiredFonts.add(`${item.fontFamily}|${style}`);
                requiredFonts.add(`Inter|${style}`); // Fallback
            });

            const loadedFonts = new Set<string>();
            const missingFonts = new Set<string>();

            const loadFontSafe = async (family: string, style: string) => {
                const id = `${family}|${style}`;
                if (loadedFonts.has(id)) return;
                try {
                    await figma.loadFontAsync({ family, style });
                    loadedFonts.add(id);
                } catch (e) {
                    missingFonts.add(family);
                    // Try to load Inter fallback for this style
                    try {
                        await figma.loadFontAsync({ family: "Inter", style });
                        loadedFonts.add(`Inter|${style}`);
                    } catch (e2) {
                        // Fallback completely to Inter Regular
                        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
                        loadedFonts.add(`Inter|Regular`);
                    }
                }
            };

            for (const fontId of requiredFonts) {
                const [family, style] = fontId.split('|');
                await loadFontSafe(family, style);
            }

            if (missingFonts.size > 0) {
                console.warn("Missing Fonts:", Array.from(missingFonts).join(", "));
                figma.notify(`Missing fonts: ${Array.from(missingFonts).join(", ")}. Using Inter fallback.`, { timeout: 4000 });
            }

            for (const item of data.items) {
                if (item.type === 'paragraph' && item.text.trim().length > 0) {
                    const text = figma.createText();
                    text.characters = item.text;

                    // Style
                    text.fontSize = item.fontSize;

                    // Font Loading Logic
                    const styleName = getStyleName(item.fontWeight, item.fontStyle);
                    const family = item.fontFamily;

                    if (loadedFonts.has(`${family}|${styleName}`)) {
                        text.fontName = { family, style: styleName };
                    } else if (loadedFonts.has(`Inter|${styleName}`)) {
                        text.fontName = { family: "Inter", style: styleName };
                    } else {
                        text.fontName = { family: "Inter", style: "Regular" };
                    }

                    // Coordinate Mapping
                    // figmaY = (pageHeight - item.y) - fontSize (roughly to get Top-Left).
                    text.x = item.x;
                    text.y = data.height - item.y - item.fontSize;

                    // Box Control
                    text.resize(item.width, item.fontSize * 1.5);
                    text.textAutoResize = "HEIGHT";

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

                    // 3. Color
                    if (item.color) {
                        try {
                            const rgbMatch = item.color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                            if (rgbMatch) {
                                const r = parseInt(rgbMatch[1]) / 255;
                                const g = parseInt(rgbMatch[2]) / 255;
                                const b = parseInt(rgbMatch[3]) / 255;
                                text.fills = [{ type: 'SOLID', color: { r, g, b } }];
                            }
                        } catch (e) {
                            // Keep default black
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
