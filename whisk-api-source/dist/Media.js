import fs from "fs";
import { Whisk } from "./Whisk.js";
import { request } from "./Utils.js";
import { VideoGenerationModel } from "./Constants.js";
import path from "path";
export class Media {
    seed;
    prompt;
    refined;
    workflowId;
    encodedMedia;
    mediaGenerationId;
    mediaType;
    aspectRatio;
    model;
    account;
    constructor(mediaConfig) {
        if (!(mediaConfig.encodedMedia)?.trim?.()) {
            throw new Error("invalid or empty media");
        }
        this.seed = mediaConfig.seed;
        this.prompt = mediaConfig.prompt;
        this.workflowId = mediaConfig.workflowId;
        this.encodedMedia = mediaConfig.encodedMedia;
        this.mediaGenerationId = mediaConfig.mediaGenerationId;
        this.aspectRatio = mediaConfig.aspectRatio;
        this.mediaType = mediaConfig.mediaType;
        this.model = mediaConfig.model;
        this.refined = mediaConfig.refined;
        this.account = mediaConfig.account;
    }
    /**
     * Deletes the generated media
     */
    async deleteMedia() {
        await Whisk.deleteMedia(this.mediaGenerationId, this.account);
    }
    /**
    * Image to Text but doesn't support videos
    *
    * @param count Number of captions to generate (min: 1, max: 8)
    */
    async caption(count = 1) {
        if (this.mediaType === "VIDEO") {
            throw new Error("videos can't be captioned");
        }
        if (count <= 0 || count > 8) {
            throw new Error("count must be in between 0 and 9 (0 < count < 9)");
        }
        return await Whisk.generateCaption(this.encodedMedia, this.account, count);
    }
    /**
     * Refine/Edit an image using nano banana
     *
     * @param edit Refinement prompt
     * @returns Refined image
     */
    async refine(edit) {
        if (this.mediaType === "VIDEO") {
            throw new Error("can't refine a video");
        }
        const refinementResult = await request("https://labs.google/fx/api/trpc/backbone.editImage", {
            headers: { cookie: this.account.getCookie() },
            body: JSON.stringify({
                "json": {
                    "clientContext": {
                        "workflowId": this.workflowId
                    },
                    "imageModelSettings": {
                        "aspectRatio": this.aspectRatio,
                        "imageModel": "GEM_PIX",
                    },
                    "editInput": {
                        "caption": this.prompt,
                        "userInstruction": edit,
                        "seed": null,
                        "safetyMode": null,
                        "originalMediaGenerationId": this.mediaGenerationId,
                        "mediaInput": {
                            "mediaCategory": "MEDIA_CATEGORY_BOARD",
                            "rawBytes": this.encodedMedia
                        }
                    }
                },
                "meta": {
                    "values": {
                        "editInput.seed": ["undefined"],
                        "editInput.safetyMode": ["undefined"]
                    }
                }
            })
        });
        const img = refinementResult.imagePanels[0].generatedImages[0];
        return new Media({
            seed: this.seed,
            prompt: img.prompt,
            workflowId: img.workflowId,
            encodedMedia: img.encodedImage,
            mediaGenerationId: this.mediaGenerationId,
            refined: true,
            aspectRatio: img.aspectRatio,
            mediaType: "IMAGE",
            model: img.imageModel,
            account: this.account,
        });
    }
    /**
    * Initiates video animation request
    * Note: Only landscape images can be animated
    *
    * @param videoScript Video script to be followed
    * @param model Video generation model to be used
    */
    async animate(videoScript, model) {
        if (this.mediaType === "VIDEO") {
            throw new Error("can't animate a video");
        }
        if (this.aspectRatio !== "IMAGE_ASPECT_RATIO_LANDSCAPE") {
            throw new Error("only landscape images can be animated");
        }
        if (!Object.values(VideoGenerationModel).includes(model)) {
            throw new Error(`'${model}': invalid video generation model provided`);
        }
        const videoStatusResults = await request("https://aisandbox-pa.googleapis.com/v1/whisk:generateVideo", {
            headers: {
                "Authorization": `Bearer ${await this.account.getToken()}`
            },
            body: JSON.stringify({
                "promptImageInput": {
                    "prompt": this.prompt,
                    "rawBytes": this.encodedMedia,
                },
                "modelNameType": model,
                "modelKey": "",
                "userInstructions": videoScript,
                "loopVideo": false,
                "clientContext": { "workflowId": this.workflowId },
            })
        });
        let i = 0;
        const id = videoStatusResults.operation.operation.name;
        while (true) {
            i++;
            const videoResults = await request("https://aisandbox-pa.googleapis.com/v1:runVideoFxSingleClipsStatusCheck", {
                headers: {
                    "Authorization": `Bearer ${await this.account.getToken()}`
                },
                body: JSON.stringify({ "operations": [{ "operation": { "name": id } }] })
            });
            // Await for 3 seconds before each request
            await new Promise(resolve => setTimeout(resolve, 3000));
            // Log response shape once so we can debug structure changes
            if (i === 1) {
                console.log('[VideoFx poll shape]', JSON.stringify(videoResults).slice(0, 600));
            }
            if (videoResults.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
                // Log full successful response to find where video bytes live
                console.log('[VideoFx success full]', JSON.stringify(videoResults).slice(0, 2000));
                // API response shape varies — try all known paths defensively
                const video = videoResults.operation?.metadata?.video
                    || videoResults.metadata?.video
                    || videoResults.video
                    || {};
                const encodedMedia = videoResults.rawBytes
                    ?? videoResults.encodedMedia
                    ?? video.rawBytes
                    ?? video.encodedMedia
                    ?? video.encodedVideo
                    ?? '';
                console.log('[VideoFx encodedMedia length]', encodedMedia.length);
                return new Media({
                    seed: video.seed ?? 0,
                    prompt: video.prompt ?? '',
                    workflowId: this.workflowId,
                    encodedMedia,
                    mediaGenerationId: videoResults.mediaGenerationId ?? video.mediaGenerationId ?? '',
                    aspectRatio: video.aspectRatio ?? 'IMAGE_ASPECT_RATIO_LANDSCAPE',
                    mediaType: "VIDEO",
                    model: video.model ?? 'VEO_3_1_I2V_12STEP',
                    account: this.account,
                });
            }
            if (i >= 60) {
                throw new Error("failed to generate video after 3 minutes: status=" + videoResults.status);
            }
        }
    }
    /**
         * Saves the media to the local disk
         *
         * @param directory Directory path to save the media (default: current directory)
         * @returns The absolute path of the saved file
         */
    save(directory = ".") {
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        let extension = this.mediaType == "VIDEO" ? "mp4" : "png";
        const base64Data = this.encodedMedia.replace(/^data:\w+\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        const timestamp = Date.now();
        const uuidShort = this.mediaGenerationId.slice(0, 4);
        const fileName = `img_${timestamp}_${uuidShort}.${extension}`;
        const filePath = path.resolve(directory, fileName);
        fs.writeFileSync(filePath, buffer);
        return filePath;
    }
}
