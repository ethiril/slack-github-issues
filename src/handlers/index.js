// Registers every Slack event handler, grouped by flow:
//   modal-flow   — the full create-issue modal pipeline
//   card-flow    — the inline issue-creation card
//   thread-sync  — @mention / reaction / add-to-issue thread flows
import { registerModalFlow } from "./modal-flow.js";
import { registerCardFlow } from "./card-flow.js";
import { registerThreadSync } from "./thread-sync.js";

export function registerHandlers(app, github) {
  registerModalFlow(app, github);
  registerCardFlow(app, github);
  registerThreadSync(app, github);
}
