import sharp from 'sharp';

export async function imageToStickerBuffer(imageBuffer: Buffer): Promise<Buffer> {
    return sharp(imageBuffer)
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({ quality: 80 })
        .toBuffer();
}

export async function stickerToImageBuffer(stickerBuffer: Buffer): Promise<Buffer> {
    return sharp(stickerBuffer)
        .png()
        .toBuffer();
}
