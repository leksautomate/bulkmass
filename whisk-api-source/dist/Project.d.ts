import { Media } from "./Media.js";
import type { PromptConfig, MediaReference } from "./Types.js";
import { Account } from "./Whisk.js";
export declare class Project {
    readonly account: Account;
    readonly projectId: string;
    readonly subjects: MediaReference[];
    readonly scenes: MediaReference[];
    readonly styles: MediaReference[];
    constructor(projectId: string, account: Account);
    generateImage(input: string | PromptConfig): Promise<Media>;
    /**
     * Uploads a custom image and adds it as a subject reference
     *
     * @param rawBytes Base64 encoded image (with or without data URI prefix)
     */
    addSubject(rawBytes: string): Promise<void>;
    /**
     * Uploads a custom image and adds it as a scene reference
     *
     * @param rawBytes Base64 encoded image (with or without data URI prefix)
     */
    addScene(rawBytes: string): Promise<void>;
    /**
     * Uploads a custom image and adds it as a style reference
     *
     * @param rawBytes Base64 encoded image (with or without data URI prefix)
     */
    addStyle(rawBytes: string): Promise<void>;
    private addReference;
    /**
     * Generate image but with subject, scene, style attached
     */
    generateImageWithReferences(input: string | PromptConfig): Promise<Media>;
    /**
    * Deletes the project, clearance of your slop from the existance
    */
    delete(): Promise<void>;
}
