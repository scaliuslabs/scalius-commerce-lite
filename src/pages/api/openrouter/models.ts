import type { APIRoute } from "astro";

export const GET: APIRoute = async () => {
  try {
    // Fetch the models from OpenRouter API
    const response = await fetch("https://openrouter.ai/api/v1/models");

    if (!response.ok) {
      throw new Error("Failed to fetch models from OpenRouter");
    }

    const data = await response.json();

    // Process models to include simplified capability metadata
    const processedModels = (data.data || []).map((model: any) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      context_length: model.context_length,
      pricing: model.pricing,
      // Extract capability information
      supportsVision: model.architecture?.input_modalities?.includes('image') || false,
      supportsAudio: model.architecture?.input_modalities?.includes('audio') || false,
      supportsImageGeneration: model.architecture?.output_modalities?.includes('image') || false,
      modality: model.architecture?.modality || 'text->text',
      inputModalities: model.architecture?.input_modalities || ['text'],
      outputModalities: model.architecture?.output_modalities || ['text'],
    }));

    return new Response(JSON.stringify({ models: processedModels }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching OpenRouter models:", error);
    return new Response(JSON.stringify({ message: "Error fetching models" }), {
      status: 500,
    });
  }
};