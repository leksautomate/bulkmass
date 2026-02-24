import { Media } from "./Media.js";
import { Project } from "./Project.js";
import { PromptConfig } from "./Types.js";
export declare class Account {
    private cookie;
    private authToken?;
    private expiryDate?;
    private userName?;
    private userEmail?;
    constructor(cookie: string, authToken?: string);
    refresh(): Promise<void>;
    getToken(): Promise<string>;
    getCookie(): string;
    isExpired(): boolean;
    toString(): string;
}
export declare class Whisk {
    readonly account: Account;
    constructor(cookie: string, authToken?: string);
    /**
     * Delete a generated media - image, video
     *
     * @param mediaId Media id or list of ids to delete
     * @param account Account{} object
     */
    static deleteMedia(mediaId: string | string[], account: Account): Promise<void>;
    /**
     * Upload a custom image to Whisk's storage
     *
     * @param rawBytes Base64 encoded image
     * @param caption Caption describing the image
     * @param category Media category (SUBJECT, SCENE, or STYLE)
     * @param workflowId Project workflow id
     * @param account Account{} object
     */
    static uploadImage(rawBytes: string, caption: string, category: string, workflowId: string, account: Account): Promise<string>;
    /**
     * Generate caption from provided base64 image
     *
     * @param input base64 encoded image
     * @param account Account{} object
     * @param count Number of captions to generate (min: 0, max: 8)
     */
    static generateCaption(input: string, account: Account, count?: number): Promise<string[]>;
    /**
     * Tries to get media from their unique id
     *
     * @param mediaId Unique identifier for generated media `mediaGenerationId`
     */
    static getMedia(mediaId: string, account: Account): Promise<Media>;
    /**
    * Create a new project for your AI slop
    *
    * @param projectName Name of the project
    */
    newProject(projectName?: string): Promise<Project>;
    /**
     * Uses imagefx's api to generate image.
     * Advantage here is it can generate multiple images in single request
     */
    generateImage(input: string | PromptConfig, count?: number): Promise<Media[]>;
}
