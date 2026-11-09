import { render } from "preact";
import { App, bootstrap } from "./App";
import "./style.css";

bootstrap();
const root = document.getElementById("app");
if (root) render(<App />, root);
