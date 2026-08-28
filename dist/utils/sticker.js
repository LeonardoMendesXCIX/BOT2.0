"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.imageToStickerBuffer = imageToStickerBuffer;
exports.stickerToImageBuffer = stickerToImageBuffer;
const sharp_1 = __importDefault(require("sharp"));
async function imageToStickerBuffer(imageBuffer) {
    return (0, sharp_1.default)(imageBuffer)
        .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
        .webp({ quality: 80 })
        .toBuffer();
}
async function stickerToImageBuffer(stickerBuffer) {
    return (0, sharp_1.default)(stickerBuffer)
        .png()
        .toBuffer();
}
