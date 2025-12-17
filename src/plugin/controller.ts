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
                    const svgNode = figma.createNodeFromSvg(data.svg);
                    svgNode.name = "Vector Graphics";
                    frame.appendChild(svgNode);
                } catch (e) {
                    console.error("Failed to create SVG node", e);
                }
            }

            // Create Text on top
            // We need to preload common fonts. In a real app we'd map PDF fonts to Figma fonts.
            // For MVP, we load Inter (Regular, Bold).
            await Promise.all([
                figma.loadFontAsync({ family: "Inter", style: "Regular" }),
                figma.loadFontAsync({ family: "Inter", style: "Bold" })
            ]);

            for (const item of data.items) {
                if (item.type === 'paragraph' && item.text.trim().length > 0) {
                    const text = figma.createText();
                    text.characters = item.text;

                    // Style
                    text.fontSize = item.fontSize;
                    if (item.fontWeight >= 700) {
                        text.fontName = { family: "Inter", style: "Bold" };
                    }

                    // Coordinate Mapping
                    // Item.y is the BOTTOM of the first line (PDF convention usually).
                    // Or depending on grouper, it might be the top?
                    // The grouper reserved the 'y' of the FIRST line found.
                    // In PDF, the first line is highest Y.
                    // So item.y is the Baseline of the first line.
                    // figmaY = (pageHeight - item.y) - fontSize (roughly to get Top-Left).

                    text.x = item.x;
                    text.y = data.height - item.y - item.fontSize;

                    // Box Control (Auto Width is default)
                    // If we want wrapping, we'd set width.
                    // text.resize(item.width, text.height); 

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
