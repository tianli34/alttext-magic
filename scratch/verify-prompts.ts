import { AltDraftContextMode } from "@prisma/client";
import { buildPrompt } from "../server/ai/prompt-engine.server.js";

const imageUrl = "https://example.com/image.jpg";
const context = { productTitle: "Awesome Sneaker" };

console.log("--- RESOURCE_SPECIFIC ---");
console.log(buildPrompt(imageUrl, context, AltDraftContextMode.RESOURCE_SPECIFIC));

console.log("\n--- FILE_NEUTRAL ---");
console.log(buildPrompt(imageUrl, context, AltDraftContextMode.FILE_NEUTRAL));

console.log("\n--- SHARED_NEUTRAL ---");
console.log(buildPrompt(imageUrl, context, AltDraftContextMode.SHARED_NEUTRAL));
