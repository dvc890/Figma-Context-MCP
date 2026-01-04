import { z } from "zod";
import { FigmaService } from "../../services/figma.js";
import { Logger } from "../../utils/logger.js";
import { RateLimitError } from "../../utils/fetch-with-retry.js";

const parameters = {
    fileKey: z
        .string()
        .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
        .describe("The key of the Figma file containing the images"),
    nodes: z
        .object({
            nodeId: z
                .string()
                .regex(
                    /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/,
                    "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'",
                )
                .describe("The ID of the Figma image node to fetch, formatted as 1234:5678"),
            imageRef: z
                .string()
                .optional()
                .describe(
                    "If a node has an imageRef fill, you must include this variable. Leave blank when downloading Vector SVG images.",
                ),
            fileName: z
                .string()
                .regex(
                    /^[a-zA-Z0-9_.-]+\.(png|svg)$/,
                    "File names must contain only letters, numbers, underscores, dots, or hyphens, and end with .png or .svg.",
                )
                .describe(
                    "A label for the image, including extension. Either png or svg.",
                ),
            filenameSuffix: z
                .string()
                .optional()
                .describe(
                    "Suffix to add to filename for unique cropped images, provided in the Figma data (e.g., 'abc123')",
                ),
        })
        .array()
        .describe("The nodes to fetch as image URLs"),
    pngScale: z
        .number()
        .positive()
        .optional()
        .default(2)
        .describe(
            "Export scale for PNG images. Optional, defaults to 2 if not specified. Affects PNG images only.",
        ),
};

const parametersSchema = z.object(parameters);
export type GetFigmaImagesUrlParams = z.infer<typeof parametersSchema>;

async function getFigmaImagesUrl(params: GetFigmaImagesUrlParams, figmaService: FigmaService) {
    try {
        const { fileKey, nodes, pngScale = 2 } = parametersSchema.parse(params);

        const results: Record<string, string> = {};

        // Group nodes by type (image fill vs node render)
        const imageFills = nodes.filter(n => !!n.imageRef);
        const renderNodes = nodes.filter(n => !n.imageRef);

        // Fetch image fill URLs
        if (imageFills.length > 0) {
            const fillUrls = await figmaService.getImageFillUrls(fileKey);
            for (const node of imageFills) {
                if (node.imageRef && fillUrls[node.imageRef]) {
                    results[node.fileName] = fillUrls[node.imageRef];
                }
            }
        }

        // Fetch node render URLs
        if (renderNodes.length > 0) {
            const pngNodes = renderNodes.filter((node) => !node.fileName.toLowerCase().endsWith(".svg"));
            const svgNodes = renderNodes.filter((node) => node.fileName.toLowerCase().endsWith(".svg"));

            if (pngNodes.length > 0) {
                const pngUrls = await figmaService.getNodeRenderUrls(
                    fileKey,
                    pngNodes.map((n) => n.nodeId.replace(/-/g, ":")),
                    "png",
                    { pngScale },
                );
                for (const node of pngNodes) {
                    const nodeId = node.nodeId.replace(/-/g, ":");
                    if (pngUrls[nodeId]) {
                        results[node.fileName] = pngUrls[nodeId];
                    }
                }
            }

            if (svgNodes.length > 0) {
                const svgUrls = await figmaService.getNodeRenderUrls(
                    fileKey,
                    svgNodes.map((n) => n.nodeId.replace(/-/g, ":")),
                    "svg",
                );
                for (const node of svgNodes) {
                    const nodeId = node.nodeId.replace(/-/g, ":");
                    if (svgUrls[nodeId]) {
                        results[node.fileName] = svgUrls[nodeId];
                    }
                }
            }
        }

        const responseText = Object.entries(results)
            .map(([fileName, url]) => `- ${fileName}: ${url}`)
            .join("\n");

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Retrieved ${Object.keys(results).length} image URLs:\n${responseText}`,
                },
            ],
        };
    } catch (error) {
        if (error instanceof RateLimitError) {
            const rateLimitMsg = error.toMessage();
            Logger.error(`Rate limit hit for ${params.fileKey}:`, rateLimitMsg);
            return {
                isError: true,
                content: [{ type: "text" as const, text: rateLimitMsg }],
            };
        }
        Logger.error(`Error getting image URLs from ${params.fileKey}:`, error);
        return {
            isError: true,
            content: [
                {
                    type: "text" as const,
                    text: `Failed to get image URLs: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
}

export const getFigmaImagesUrlTool = {
    name: "get_figma_images_url",
    description:
        "Get temporary download URLs for SVG and PNG images in a Figma file. WARNING: This tool is subject to Figma API rate limits. Please avoid frequent polling and attempt to batch your requests if possible. If you receive a 429 error, you MUST wait for the specified 'Retry-After' duration before calling this tool again.",
    parameters,
    handler: getFigmaImagesUrl,
} as const;
