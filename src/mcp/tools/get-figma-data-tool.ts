import { z } from "zod";
import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import { FigmaService } from "~/services/figma.js";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
} from "~/extractors/index.js";
import yaml from "js-yaml";
import { Logger, writeLogs } from "~/utils/logger.js";
import { RateLimitError } from "~/utils/fetch-with-retry.js";

const parameters = {
  // ... (lines 12-45 remain same, I will use multi_replace for cleaner edits if needed, but let's try one block)

  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe(
      "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
    ),
  nodeId: z
    .string()
    .regex(
      /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/,
      "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'",
    )
    .optional()
    .describe(
      "The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided. Use format '1234:5678' or 'I5666:180910;1:10515;1:10336' for multiple nodes.",
    ),
  depth: z
    .number()
    .optional()
    .describe(
      "OPTIONAL. Do NOT use unless explicitly requested by the user. Controls how many levels deep to traverse the node tree.",
    ),
};

const parametersSchema = z.object(parameters);
export type GetFigmaDataParams = z.infer<typeof parametersSchema>;

// Simplified handler function
async function getFigmaData(
  params: GetFigmaDataParams,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
) {
  try {
    const { fileKey, nodeId: rawNodeId, depth } = parametersSchema.parse(params);

    // Replace - with : in nodeId for our query—Figma API expects :
    const nodeId = rawNodeId?.replace(/-/g, ":");

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}`,
    );

    // If no nodeId is provided, default depth to 1 to avoid fetching massive files and timing out
    let fetchDepth = depth;
    if (!nodeId && fetchDepth === undefined) {
      Logger.log("No nodeId or depth provided for full file fetch. Defaulting depth to 1 to prevent timeouts.");
      fetchDepth = 1;
    }

    // Get raw Figma API response
    let rawApiResponse: GetFileResponse | GetFileNodesResponse;
    if (nodeId) {
      rawApiResponse = await figmaService.getRawNode(fileKey, nodeId, fetchDepth);
    } else {
      rawApiResponse = await figmaService.getRawFile(fileKey, fetchDepth);
    }

    // Use unified design extraction (handles nodes + components consistently)
    const simplifiedDesign = simplifyRawFigmaObject(rawApiResponse, allExtractors, {
      maxDepth: depth,
      afterChildren: collapseSvgContainers,
    });

    writeLogs("figma-simplified.json", simplifiedDesign);

    Logger.log(
      `Successfully extracted data: ${simplifiedDesign.nodes.length} nodes, ${Object.keys(simplifiedDesign.globalVars.styles).length
      } styles`,
    );

    const { nodes, globalVars, ...metadata } = simplifiedDesign;
    const result = {
      metadata,
      nodes,
      globalVars,
    };

    Logger.log(`Generating ${outputFormat.toUpperCase()} result from extracted data`);
    const formattedResult =
      outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

    Logger.log("Sending result to client");
    return {
      content: [{ type: "text" as const, text: formattedResult }],
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
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error fetching file ${params.fileKey}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error fetching file: ${message}` }],
    };
  }
}

// Export tool configuration
export const getFigmaDataTool = {
  name: "get_figma_data",
  description:
    "Get comprehensive Figma file data including layout, content, visuals, and component information. WARNING: This tool is subject to Figma API rate limits. IMPORTANT: Fetching full files or very deep node trees can be extremely slow and may cause a 'context deadline exceeded' error or timeout. To avoid this, ALWAYS prefer providing a 'nodeId' and a small 'depth' (e.g., 1 or 2). For large files, start with depth 1 to explore the structure and then drill down into specific nodes. If you receive a 429 error, you MUST wait for the specified 'Retry-After' duration before calling this tool again.",
  parameters,
  handler: getFigmaData,
} as const;
