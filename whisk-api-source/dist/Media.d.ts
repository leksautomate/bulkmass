import { type Account } from "./Whisk.js";
import type { VideoAspectRatioType, ImageAspectRatioType, ImageGenerationModelType, MediaConfig, VideoGenerationModelType, ImageRefinementModelType } from "./Types.js";
export declare class Media {
    readonly seed: number;
    readonly prompt: string;
    readonly refined?: boolean;
    readonly workflowId: string;
    readonly encodedMedia: string;
    readonly mediaGenerationId: string;
    readonly mediaType: "VIDEO" | "IMAGE";
    readonly aspectRatio: ImageAspectRatioType | VideoAspectRatioType;
    readonly model: ImageGenerationModelType | VideoGenerationModelType | ImageRefinementModelType;
    readonly account: Account;
    constructor(mediaConfig: MediaConfig);
    /**
     * Deletes the generated media
     */
    deleteMedia(): Promise<void>;
    /**
    * Image to Text but doesn't support videos
    *
    * @param count Number of captions to generate (min: 1, max: 8)
    */
    caption(count?: number): Promise<string[]>;
    /**
     * Refine/Edit an image using nano banana
     *
     * @param edit Refinement prompt
     * @returns Refined image
     */
    refine(edit: string): Promise<Media>;
    /**
    * Initiates video animation request
    * Note: Only landscape images can be animated
    *
    * @param videoScript Video script to be followed
    * @param model Video generation model to be used
    */
    animate(videoScript: string, model: VideoGenerationModelType): Promise<Media>;
    /**
         * Saves the media to the local disk
         *
         * @param directory Directory path to save the media (default: current directory)
         * @returns The absolute path of the saved file
         */
    save(directory?: string): string;
}
