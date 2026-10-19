import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCanvas, Image, ImageData, Canvas, loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, weld, simplify, meshopt, textureCompress } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";
import { Loader, LoadingManager, Texture, MeshStandardMaterial } from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = path.resolve(process.argv[2] || path.join(root, "models/CoE_Model.fbx"));
const output = path.resolve(process.argv[3] || path.join(root, "models/CoE_Model.glb"));
const textureSize = Number(process.argv[4] || 2048);

if (input === output || path.extname(output).toLowerCase() !== ".glb") {
    throw new Error("Choose a separate .glb output file; the original FBX is preserved.");
}

if (!Number.isInteger(textureSize) || textureSize < 64 || textureSize > 8192) {
    throw new Error("Texture size must be an integer between 64 and 8192.");
}

globalThis.HTMLImageElement = Image;
globalThis.ImageData = ImageData;
globalThis.HTMLCanvasElement = Canvas;

globalThis.document = {
    createElement(name) {
        if (name !== "canvas") {
            throw new Error(`Unsupported element: ${name}`);
        }

        const canvas = createCanvas(1, 1);

        canvas.toBlob = (callback, mime = "image/png") => {
            const buffer = canvas.toBuffer(mime);
            callback(new Blob([buffer], { type: mime }));
        };

        return canvas;
    }
};

globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
        blob.arrayBuffer().then((result) => {
            this.result = result;
            this.onloadend?.();
        });
    }

    readAsDataURL(blob) {
        blob.arrayBuffer().then((result) => {
            const base64 = Buffer.from(result).toString("base64");

            this.result = `data:${blob.type};base64,${base64}`;
            this.onloadend?.();
        });
    }
};

globalThis.window = {
    innerWidth: 1280,
    innerHeight: 720
};

const pending = [];
const images = new Map();

class NodeTextureLoader extends Loader {
    load(url) {
        const texture = new Texture();
        const isEmbedded = /^(blob:|data:)/.test(url);

        let location = url;

        if (!isEmbedded) {
            location = path.resolve(this.path || path.dirname(input), url);
        }

        if (!images.has(location)) {
            images.set(location, (async () => {
                let bytes;

                if (/^(blob:|data:)/.test(location)) {
                    const response = await fetch(location);
                    bytes = Buffer.from(await response.arrayBuffer());
                } else {
                    bytes = await readFile(location);
                }

                const resized = await sharp(bytes)
                    .resize({
                        width: textureSize,
                        height: textureSize,
                        fit: "inside",
                        withoutEnlargement: true
                    })
                    .png()
                    .toBuffer();

                return loadImage(resized);
            })());
        }

        const imagePromise = images.get(location);

        pending.push(imagePromise.then((image) => {
            texture.image = image;
            texture.needsUpdate = true;
        }));

        return texture;
    }
}

console.log(`Reading ${input}`);

const source = await readFile(input);
const manager = new LoadingManager();

manager.addHandler(/.*/, new NodeTextureLoader(manager));

const sourceBuffer = source.buffer.slice(
    source.byteOffset,
    source.byteOffset + source.byteLength
);

const model = new FBXLoader(manager).parse(
    sourceBuffer,
    `${path.dirname(input)}${path.sep}`
);

await Promise.all(pending);

const remove = [];
const materials = new Map();


let meshCount = 0;

function convertMaterial(original) {
    if (materials.has(original)) {
        return materials.get(original);
    }

    const material = new MeshStandardMaterial();

    const properties = [
        "name",
        "map",
        "aoMap", // ambient occlusion
        "emissiveMap",
        "alphaMap",
        "opacity",
        "transparent",
        "alphaTest",
        "side",
        "vertexColors",
        "depthWrite" // normal mapping
    ];

    for (const property of properties) {
        if (original[property] !== undefined) {
            material[property] = original[property];
        }
    }

    material.color.copy(original.color);

    if (original.emissive) {
        material.emissive.copy(original.emissive);
        material.emissiveIntensity = original.emissiveIntensity;
    }

    if (original.normalScale) {
        material.normalScale.copy(original.normalScale);
    }

    if (original.shininess !== undefined) {
        const roughness = Math.sqrt(2 / (original.shininess + 2));
        material.roughness = Math.max(0.35, Math.min(1, roughness));
    } 
    else {
        material.roughness = 1;
    }

    material.metalness = 0;

    materials.set(original, material);

    return material;
}

model.traverse((part) => {
    if (part.isLight || part.isCamera) {
        remove.push(part);
    }

    if (part.isMesh) {
        meshCount++;

        if (Array.isArray(part.material)) {
            part.material = part.material.map(convertMaterial);
        } else {
            part.material = convertMaterial(part.material);
        }
    }
});

for (const part of remove) {
    part.removeFromParent();
}

if (meshCount === 0) {
    throw new Error("The FBX contains no meshes.");
}

console.log(`Exporting ${meshCount} meshes; removed ${remove.length} lights/cameras.`);

const glb = await new GLTFExporter().parseAsync(model, {
    binary: true,
    maxTextureSize: textureSize,
    animations: model.animations
});

await Promise.all([
    MeshoptEncoder.ready,
    MeshoptDecoder.ready
]);

const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
        "meshopt.encoder": MeshoptEncoder,
        "meshopt.decoder": MeshoptDecoder
    });

const document = await io.readBinary(new Uint8Array(glb));

console.log("Optimizing textures and geometry...");

await document.transform(
    dedup(),
    weld(),
    simplify({
        simplifier: MeshoptSimplifier,
        ratio: 0.5,
        error: 0.0005,
        lockBorder: true
    }),
    prune(),
    textureCompress({
        encoder: sharp,
        targetFormat: "webp",
        resize: [textureSize, textureSize],
        quality: 82
    }),
    meshopt({
        encoder: MeshoptEncoder,
        level: "medium"
    })
);

async function saveModelWithTextures() {
    const textureDirectory = path.join(root, "texture");
    const textures = document.getRoot().listTextures();
    const blueMaterial = document.getRoot().listMaterials().find(function (material) {
        return material.getName() === "BlueMetal";
    });

    for (let i = 0; i < textures.length; i++) {
        let name = `texture_${i + 1}.webp`;

        if (blueMaterial && textures[i] === blueMaterial.getBaseColorTexture()) {
            name = "blue_metal.webp";
        } else if (textures.length === 2) {
            name = "concrete.webp";
        }

        textures[i].setURI(name);
    }

    const result = await io.writeJSON(document);
    const json = result.json;
    const binary = Buffer.from(result.resources[json.buffers[0].uri]);
    delete json.buffers[0].uri;

    await mkdir(textureDirectory, { recursive: true });

    for (const image of json.images || []) {
        const imagePath = path.join(textureDirectory, image.uri);
        await writeFile(imagePath, result.resources[image.uri]);
        image.uri = path.relative(path.dirname(output), imagePath).split(path.sep).join("/");
    }
    
    const jsonBytes = Buffer.from(JSON.stringify(json));
    const jsonChunk = Buffer.alloc(Math.ceil(jsonBytes.length / 4) * 4, 0x20);
    jsonBytes.copy(jsonChunk);
    const binaryChunk = Buffer.alloc(Math.ceil(binary.length / 4) * 4);
    binary.copy(binaryChunk);

    const header = Buffer.alloc(20);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(28 + jsonChunk.length + binaryChunk.length, 8);
    header.writeUInt32LE(jsonChunk.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);

    const binaryHeader = Buffer.alloc(8);
    binaryHeader.writeUInt32LE(binaryChunk.length, 0);
    binaryHeader.writeUInt32LE(0x004e4942, 4);

    const modelBytes = Buffer.concat([header, jsonChunk, binaryHeader, binaryChunk]);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, modelBytes);
    return modelBytes;
}

const compressed = await saveModelWithTextures();
const verified = await io.read(output);

if (verified.getRoot().listMeshes().length === 0) {
    throw new Error("Output validation failed: no meshes.");
}

console.log(`Saved ${output}`);

const originalSize = source.length / 1e6;
const compressedSize = compressed.length / 1e6;
let textureBytes = 0;

for (const texture of document.getRoot().listTextures()) {
    textureBytes += texture.getImage().length;
}

const totalSize = (compressed.length + textureBytes) / 1e6;
const reduction = (1 - (compressed.length + textureBytes) / source.length) * 100;

console.log(`Geometry: ${compressedSize.toFixed(2)} MB; textures: ${(textureBytes / 1e6).toFixed(2)} MB`);
console.log(`${originalSize.toFixed(2)} MB -> ${totalSize.toFixed(2)} MB total (${reduction.toFixed(1)}% smaller)`);

