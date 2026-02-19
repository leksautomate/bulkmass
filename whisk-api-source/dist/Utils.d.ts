import type { ImageExtensionTypes } from "./Types.js";
/**
 * Make a request, thats all
 *
 * @param input URL or Request object
 * @param init Settings for request() method
 */
export declare function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T>;
/**
 * Returns base64 encoded image
 *
 * @param imagePath Path to image file
 * @param imageType Extension of image (if that matters)
 */
export declare function imageToBase64(imagePath: string, imageType?: ImageExtensionTypes): Promise<string>;
