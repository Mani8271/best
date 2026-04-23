const express = require("express");
const crypto = require("crypto");
const auth = require("../middleware/auth.js");
const ReferralLink = require("../models/ReferralLink.js");

const router = express.Router();

const createDefaultReferralLinks = async (userId, t = null) => {
  const positions = ["LEFT", "RIGHT"];
  for (const position of positions) {
    const code = crypto.randomBytes(24).toString("hex");
    await ReferralLink.create(
      {
        sponsorId: userId,
        code,
        position,
        isActive: true,
      },
      { transaction: t }
    );
  }
};

// GET /api/referrals
router.get("/", auth, async (req, res) => {
  try {
    const links = await ReferralLink.findAll({
      where: { sponsorId: req.user.id },
    });

    const linksWithUrl = links.map((link) => {
      const linkData = link.toJSON ? link.toJSON() : link;
      return {
        ...linkData,
        url: `https://mysun.in/register?ref=${link.code}&pos=${link.position
          }&by=${encodeURIComponent(req.user.name)}`,
      };
    });

    return res.json(linksWithUrl);
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

// POST /api/referrals/create
// Body: { position: "LEFT" | "RIGHT" }
router.post("/create", auth, async (req, res) => {
  try {
    const position = String(req.body.position || "").toUpperCase();
    if (!["LEFT", "RIGHT"].includes(position)) {
      return res.status(400).json({ msg: "position must be LEFT or RIGHT" });
    }

    const code = crypto.randomBytes(24).toString("hex");

    await ReferralLink.create({
      sponsorId: req.user.id,
      code,
      position,
      isActive: true,
    });

    const url = `https://web.mysun.in/register?ref=${code}&pos=${position}&by=${encodeURIComponent(
      req.user.name
    )}`;

    return res.json({ msg: "Created", position, referralCode: code, url });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

module.exports = router;
router.createDefaultReferralLinks = createDefaultReferralLinks;