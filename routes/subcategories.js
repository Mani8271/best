import express from "express";
import Category from "../models/Category.js";
import SubCategory from "../models/SubCategory.js";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";
import optionalAuth from "../middleware/optionalAuth.js";
import { uploadSubCategoryImage, getPublicPath } from "../config/upload.js";

const router = express.Router();

const imgPath = (file) => getPublicPath(file);

/**
 * ✅ GET subcategories
 * Supports:
 *  - /api/subcategories?categoryId=1
 *  - /api/subcategories?categoryName=Medicines
 *  - /api/subcategories (all)
 */
router.get("/", optionalAuth, async (req, res) => {
  try {
    const { categoryId, categoryName } = req.query;

    const where = {};

    if (categoryId) {
      where.categoryId = categoryId;
    } else if (categoryName) {
      // find category by name, then filter subcategories
      const cat = await Category.findOne({
        where: { name: categoryName.trim() },
        attributes: ["id"],
      });

      if (!cat) return res.json([]); // no category => no subcategories
      where.categoryId = cat.id;
    }

    const rows = await SubCategory.findAll({
      where,
      order: [["name", "ASC"]],
    });

    res.json(rows);
  } catch (e) {
    res.status(500).json({ msg: e.message });
  }
});

// ✅ GET single
router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const row = await SubCategory.findByPk(req.params.id);
    if (!row) return res.status(404).json({ msg: "SubCategory not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ msg: e.message });
  }
});

// ✅ CREATE (admin) + image (form-data)
router.post("/", auth, (req, res) => {
  uploadSubCategoryImage(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ msg: err.message });

      const categoryId = req.body.categoryId;
      const name = (req.body.name || "").trim();

      if (!categoryId) return res.status(400).json({ msg: "categoryId required" });
      if (!name) return res.status(400).json({ msg: "name required" });

      const cat = await Category.findByPk(categoryId);
      if (!cat) return res.status(400).json({ msg: "Invalid categoryId" });

      const created = await SubCategory.create({
        categoryId,
        name,
        image: imgPath(req.file),
      });

      res.status(201).json(created);
    } catch (e) {
      res.status(500).json({ msg: e.message });
    }
  });
});

// ✅ UPDATE (admin) + image optional
router.put("/:id", auth, (req, res) => {
  uploadSubCategoryImage(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ msg: err.message });

      const row = await SubCategory.findByPk(req.params.id);
      if (!row) return res.status(404).json({ msg: "SubCategory not found" });

      const categoryId = req.body.categoryId ?? row.categoryId;
      const name = (req.body.name || row.name || "").trim();

      if (!categoryId) return res.status(400).json({ msg: "categoryId required" });
      if (!name) return res.status(400).json({ msg: "name required" });

      const cat = await Category.findByPk(categoryId);
      if (!cat) return res.status(400).json({ msg: "Invalid categoryId" });

      await row.update({
        categoryId,
        name,
        image: req.file ? imgPath(req.file) : row.image,
      });

      res.json(row);
    } catch (e) {
      res.status(500).json({ msg: e.message });
    }
  });
});

// ✅ DELETE (admin)
router.delete("/:id", auth, async (req, res) => {
  try {
    const row = await SubCategory.findByPk(req.params.id);
    if (!row) return res.status(404).json({ msg: "SubCategory not found" });

    await row.destroy();
    res.json({ msg: "SubCategory deleted" });
  } catch (e) {
    res.status(500).json({ msg: e.message });
  }
});

export default router;
