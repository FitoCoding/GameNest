import express from "express";
import { neon } from "@neondatabase/serverless";

const sql = neon("postgresql://gamenest_owner:2vdbTsro7fYp@ep-noisy-firefly-a5i6652r.us-east-2.aws.neon.tech/gamenest?sslmode=require");
const router = express.Router();

router.get("/", async (req, res) => {
  const games = await sql("SELECT * FROM games LIMIT 9");
  res.json({ success: true, games });
});

export default router;
