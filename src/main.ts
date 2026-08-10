import "./style.css";
import { mount } from "./ui.ts";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("#app not found");
mount(app);
