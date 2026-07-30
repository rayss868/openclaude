export const DESCRIPTION = `- Signals that you have completed the current task
- Use this tool when you have fully accomplished what was requested
- No parameters are needed - simply call the tool to indicate completion

## When to use TaskComplete
- After finishing all steps of a task
- When you have successfully completed the user's request
- After running verification, tests, or build steps that pass
- When you are ready to present the final result to the user

## When NOT to use TaskComplete
- If you still have pending work to do
- If you encountered errors that need resolution
- If you need to continue with more steps
- If you are waiting for tool results before proceeding

Always call TaskComplete when you are truly done. This signals to the system that your work is finished and no further action is needed.`
