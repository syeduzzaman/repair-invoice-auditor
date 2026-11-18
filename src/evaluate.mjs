import { evaluate } from "./benchmark.mjs";
import { createDemoProvider, createOpenAIProvider } from "./providers.mjs";

try {
  const useOpenAI = process.argv.includes("--openai");
  const provider = useOpenAI
    ? createOpenAIProvider({ key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL })
    : createDemoProvider();
  const result = await evaluate(provider);
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes("--assert") && [result.multi, result.single].some((row) => row.casesPassed !== row.cases)) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
