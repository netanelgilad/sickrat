import { openGrantedBrowserSession } from "../src/index.ts";

const transaction = openGrantedBrowserSession();
await transaction.read();
await transaction.abort("unchanged");
