// routes/banners.js
import express from "express";
import { Op } from "sequelize";
import Banner from "../models/Banner.js";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";
import { uploadBannerImage, getPublicPath } from "../config/upload.js";

const router = express.Router();

/* ================= PUBLIC: GET ACTIVE BANNERS =================
GET /api/banners/public?placement=HOME_TOP&type=SLIDER
*/
router.get("/public", async (req, res) => {
  try {
    const placement = (req.query.placement || "").trim();
    const type = (req.query.type || "").trim();

    const where = { isActive: true };

    if (placement) where.placement = placement;
    if (type) where.type = type;

    // schedule filter
    const now = new Date();
    where[Op.and] = [
      { [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: now } }] },
      { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gte]: now } }] },
    ];

    const banners = await Banner.findAll({
      where,
      order: [["sortOrder", "ASC"], ["createdAt", "DESC"]],
    });

    res.json(banners);
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Failed to load banners" });
  }
});

/* ================= ADMIN: LIST (WITH SEARCH) =================
GET /api/banners?search=&placement=&type=
*/
router.get("/", auth, isAdmin, async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const placement = (req.query.placement || "").trim();
    const type = (req.query.type || "").trim();

    const where = {};

    if (placement) where.placement = placement;
    if (type) where.type = type;

    if (search) {
      where[Op.or] = [
        { title: { [Op.like]: `%${search}%` } },
        { subtitle: { [Op.like]: `%${search}%` } },
        { placement: { [Op.like]: `%${search}%` } },
      ];
    }

    const list = await Banner.findAll({
      where,
      order: [["placement", "ASC"], ["sortOrder", "ASC"], ["createdAt", "DESC"]],
    });

    res.json({ total: list.length, banners: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Failed to load banners" });
  }
});

/* ================= ADMIN: CREATE =================
POST /api/banners (multipart/form-data)
fields: title, subtitle, linkUrl, placement, type, sortOrder, isActive, startsAt, endsAt
file: image
*/
router.post("/", auth, isAdmin, (req, res) => {
  uploadBannerImage(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ msg: err.message });
      if (!req.file) return res.status(400).json({ msg: "Image required" });

      const image = getPublicPath(req.file);

      const banner = await Banner.create({
        title: req.body.title || "",
        subtitle: req.body.subtitle || "",
        linkUrl: req.body.linkUrl || "",
        placement: req.body.placement || "HOME_TOP",
        type: req.body.type || "SLIDER",
        sortOrder: Number(req.body.sortOrder || 0),
        isActive: req.body.isActive === "false" ? false : true,
        startsAt: req.body.startsAt ? new Date(req.body.startsAt) : null,
        endsAt: req.body.endsAt ? new Date(req.body.endsAt) : null,
        image,
      });

      res.status(201).json(banner);
    } catch (e) {
      console.error(e);
      res.status(500).json({ msg: "Create failed" });
    }
  });
});

/* ================= ADMIN: UPDATE =================
PUT /api/banners/:id (multipart/form-data)
image optional
*/
router.put("/:id", auth, isAdmin, (req, res) => {
  uploadBannerImage(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ msg: err.message });

      const banner = await Banner.findByPk(req.params.id);
      if (!banner) return res.status(404).json({ msg: "Not found" });

      const patch = {
        title: req.body.title ?? banner.title,
        subtitle: req.body.subtitle ?? banner.subtitle,
        linkUrl: req.body.linkUrl ?? banner.linkUrl,
        placement: req.body.placement ?? banner.placement,
        type: req.body.type ?? banner.type,
        sortOrder: req.body.sortOrder != null ? Number(req.body.sortOrder) : banner.sortOrder,
        isActive: req.body.isActive != null ? req.body.isActive !== "false" : banner.isActive,
        startsAt: req.body.startsAt ? new Date(req.body.startsAt) : banner.startsAt,
        endsAt: req.body.endsAt ? new Date(req.body.endsAt) : banner.endsAt,
      };

      if (req.file) patch.image = getPublicPath(req.file);

      await banner.update(patch);
      res.json(banner);
    } catch (e) {
      console.error(e);
      res.status(500).json({ msg: "Update failed" });
    }
  });
});

/* ================= ADMIN: DELETE (SOFT) =================
DELETE /api/banners/:id
*/
router.delete("/:id", auth, isAdmin, async (req, res) => {
  try {
    const banner = await Banner.findByPk(req.params.id);
    if (!banner) return res.status(404).json({ msg: "Not found" });

    await banner.destroy();

    res.json({ msg: "Banner deleted permanently" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Delete failed" });
  }
});

export default router;
