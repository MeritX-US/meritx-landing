import { GoogleGenerativeAI } from '@google/generative-ai';

export async function researchEntity(
  entityType: string,
  entityName: string,
  genAI: GoogleGenerativeAI
): Promise<string | null> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} }] as any
  });

  let customPrompt = "";
  switch (entityType) {
    case 'award_names':
      customPrompt = `Search for the award/prize "${entityName}". Determine its prestige and significance. Identify the judging panel, selection criteria, and notable past winners. Write a professional summary of its prestige.`;
      break;
    case 'media_names':
      customPrompt = `Search for the media outlet or publication "${entityName}". Identify its circulation, target audience, national or international reach, and overall industry ranking or prestige. Write a professional summary.`;
      break;
    case 'association_names':
      customPrompt = `Search for the professional association "${entityName}". Identify its admission criteria, selectivity, and notable members. Write a professional summary proving whether it requires outstanding achievements for membership.`;
      break;
    case 'journal_names':
      customPrompt = `Search for the scholarly journal "${entityName}". Identify its impact factor, ranking in its field, and overall prestige. Write a professional summary of its significance.`;
      break;
    case 'organization_names':
      customPrompt = `Search for the organization/company "${entityName}". Identify its distinguished reputation, industry ranking, market impact, and notable achievements. Write a professional summary of its prestige.`;
      break;
    case 'exhibition_names':
      customPrompt = `Search for the artistic exhibition or venue "${entityName}". Identify its prestige, curator credentials, selection criteria, and national/international reach. Write a professional summary.`;
      break;
    default:
      return null;
  }

  const prompt = `You are an expert immigration legal researcher. Your task is to research an entity to establish its prestige for an EB-1A (Extraordinary Ability) petition.

${customPrompt}

Provide the output in clean Markdown format with the following structure (if applicable):
# Background Research: ${entityName}
## Overview
## Prestige & Significance
## Objective Criteria (e.g., selectivity, circulation, impact factor)
## Notable Affiliations (e.g., judges, members, winners)

STRICT RULE: Base your summary entirely on actual search results. Do not hallucinate data. If you cannot find reliable information, state that clearly.
`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    console.error(`Error researching entity ${entityName}:`, error);
    return null;
  }
}
