import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const MODELS = [
    {
        name: "CoE Model",
        url: "/models/CoE_Model.glb",
        position: [0, 0, -32],
        rotation: [0, 0, 0],
        maxSize: 70
    }
];

export async function loadModels(scene, collisionWorld) {
    if (!scene || !scene.isScene) {
        throw new Error("Cannot load models: no scene found.");
    }

    const manager = new THREE.LoadingManager();
    const textureErrors = [];

    manager.onError = function (url) {
        textureErrors.push(url);
    };

    const loader = new GLTFLoader(manager);
    loader.setMeshoptDecoder(MeshoptDecoder);

    const loadedModels = new Map();

    async function loadModel(config) {
        const response = await fetch(config.url, {
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            throw new Error(`Model request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.arrayBuffer();
        textureErrors.length = 0;
        const modelDirectory = new URL(".", new URL(config.url, window.location.href)).href;
        const result = await loader.parseAsync(data, modelDirectory);

        if (textureErrors.length > 0) {
            throw new Error(`Cannot load model texture: ${textureErrors.join(", ")}`);
        }
        const model = result.scene;

        const lights = [];

        model.traverse((part) => {
            if (part.isLight) {
                lights.push(part);
            }
        });

        for (const light of lights) {
            light.removeFromParent();
        }

        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        const largestSize = Math.max(size.x, size.y, size.z);

        if (!Number.isFinite(largestSize) || largestSize <= 0) {
            throw new Error(`${config.name} has no usable model geometry.`);
        }

        model.scale.setScalar(config.maxSize / largestSize);
        model.rotation.set(...config.rotation);
        model.position.set(...config.position);

        const scaledBounds = new THREE.Box3().setFromObject(model);
        const center = scaledBounds.getCenter(new THREE.Vector3());

        model.position.x += config.position[0] - center.x;
        model.position.z += config.position[2] - center.z;
        model.position.y += config.position[1] - scaledBounds.min.y;

        model.traverse((part) => {
            if (part.isMesh) {
                part.castShadow = true;
                part.receiveShadow = true;
            }
        });

        scene.add(model);
        collisionWorld.addModel(model);
        loadedModels.set(config.name, model);

        console.log(`Loaded model: ${config.name}`);
        return model;
    }

    for (const config of MODELS) {
        await loadModel(config);
    }

    window.FPS_MODELS = loadedModels;
    return loadedModels;
}
