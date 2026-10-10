// This is server file, use 'npm run dev' in the powershell to run the server
import path from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";

const app = express();
const port = process.env.PORT || 5000;

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.resolve(projectDir, "templates");
const stylesDir = path.join(projectDir, "styles");

app.use(express.static(path.join(projectDir, "public")));
app.use("/styles", express.static(stylesDir));
app.use("/src", express.static(path.join(projectDir, "src")));
app.use("/models", express.static(path.join(projectDir, "models")));
app.use("/texture", express.static(path.join(projectDir, "texture")));
app.use("/vendor/three", express.static(path.join(projectDir, "node_modules/three/build")));
app.use("/vendor/three/addons", express.static(path.join(projectDir, "node_modules/three/examples/jsm")));
app.use("/vendor/three-mesh-bvh", express.static(path.join(projectDir, "node_modules/three-mesh-bvh/build")));

// Here I will route the page using express router --> you all can implement from here ^^
const pageRouter = express.Router();
pageRouter.get("/", (req, res) => {
    res.sendFile(path.join(templateDir, "TitlePage.html"));
});

pageRouter.get("/fps-prototype", (req, res) => {
    res.sendFile(path.join(templateDir, "fps_prototype.html"));
});

app.use("/", pageRouter);

app.listen(port, "0.0.0.0", () => {
    console.log(`Server on http://localhost:${port}`);
});

