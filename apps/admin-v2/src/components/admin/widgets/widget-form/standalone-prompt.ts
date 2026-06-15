export function buildStandalonePrompt({
  combinedPrompt,
  imageCount,
}: {
  combinedPrompt: string;
  imageCount: number;
}) {
  return `# STANDALONE WIDGET GENERATOR PROMPT

**Instructions**: Copy this entire prompt and paste it into your preferred AI chatbot (ChatGPT, Claude, Gemini, etc.). After receiving the response, copy the \`<htmljs>\`, \`<css>\`, and optional \`<js>\` sections and paste them back using the "Paste AI Response" button.

===============================================================

${combinedPrompt}

===============================================================

**IMPORTANT**: Your response must use this EXACT format:

<htmljs>
<!-- Your complete HTML code here. Keep scripts out of HTML. -->
</htmljs>

<css>
/* Your complete CSS code here */
</css>

<js>
/* Optional root-scoped behavior. Use widget.root/query/queryAll only. */
</js>

Do NOT use markdown code blocks. Do NOT use JSON format. Use ONLY the tags shown above.
${imageCount > 0 ? `\n\n**Note**: ${imageCount} image URL(s) provided above. Use them in your HTML.` : ''}`;
}
