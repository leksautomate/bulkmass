import { Media } from "./Media.js";
import type { PromptConfig } from "./Types.js";
import { Account } from "./Whisk.js";
export declare class Project {
    readonly account: Account;
    readonly projectId: string;
    constructor(projectId: string, account: Account);
    generateImage(input: string | PromptConfig): Promise<Media>;
    /**
    * Deletes the project, clearance of your slop from the existance
    */
    delete(): Promise<void>;
}
