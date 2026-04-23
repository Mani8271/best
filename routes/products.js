
import express from "express";
import Product from "../models/Product.js";
import { uploadProductImages, getPublicPath } from "../config/upload.js";
import { Op } from "sequelize";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";
import Category from "../models/Category.js";
import SubCategory from "../models/SubCategory.js";


import optionalAuth from "../middleware/optionalAuth.js";


const router = express.Router();

const toNum = (v, def = 0) => {
  if (v === undefined || v === null || v === "") return def;
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
};

/* ================= GET ALL / SEARCH PRODUCTS ================= */
// Supports: GET /api/products AND /api/products/search
const getProducts = async (req, res) => {
  try {
    let { search, serch, category, subCategory, subCategoryId, badge, featured, inStock, page, limit, linit } = req.query;

    // Use 'linit' as fallback if 'limit' is missing (to handle potential typo)
    limit = limit || linit;

    // Pagination defaults
    page = Math.max(1, toNum(page, 1));
    limit = Math.max(1, toNum(limit, 12));
    const offset = (page - 1) * limit;

    console.log("DEBUG Products API:", { page, limit, offset, query: req.query });

    const where = { isActive: true };

    const q = (search || serch || "").trim();
    if (q) {
      where[Op.or] = [
        { name: { [Op.like]: `${q}%` } },
        // { categoryName: { [Op.like]: `%${q}%` } },
        // { subCategoryName: { [Op.like]: `%${q}%` } },
        // { brand: { [Op.like]: `%${q}%` } },
        // { manufacturer: { [Op.like]: `%${q}%` } },
      ];
    }

    if (category) where.categoryName = category;
    if (subCategory) where.subCategoryName = subCategory;

    if (subCategoryId) {
      const subCat = await SubCategory.findByPk(subCategoryId);
      if (subCat) {
        where.subCategoryName = subCat.name;
      } else {
        return res.json({ products: [], totalItems: 0, totalPages: 0, currentPage: page });
      }
    }

    if (badge) where.badge = badge;
    if (featured === "true") where.featured = true;
    if (inStock === "true") where.stockQty = { [Op.gt]: 0 };

    // Optimize: Fetch only necessary fields for list view
    const { count, rows: products } = await Product.findAndCountAll({
      where,
      attributes: [
        "id", "name", "brand", "categoryName", "subCategoryName",
        "price", "mrp", "stockQty", "featured", "badge", "images",
        "entrepreneurDiscount", "traineeEntrepreneurDiscount", "isActive"
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    // ✅ Apply discount based on userType (default: TRAINEE_ENTREPRENEUR)
    const userType = (req.user?.userType || "TRAINEE_ENTREPRENEUR").toUpperCase();

    const productsWithPrices = products.map(p => {
      const product = p.get({ plain: true });
      const price = Number(product.price || 0);
      let discPercent = 0;

      if (userType === "ENTREPRENEUR") {
        discPercent = Number(product.entrepreneurDiscount || 0);
      } else {
        discPercent = Number(product.traineeEntrepreneurDiscount || 0);
      }

      product.discountedPrice = Number((price - (price * discPercent) / 100).toFixed(2));
      return product;
    });

    res.json({
      products: productsWithPrices,
      totalItems: count,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      limit
    });
  } catch (err) {
    console.error("GET /api/products error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};

router.get("/", optionalAuth, getProducts);
router.get("/search", optionalAuth, getProducts);

/* ================= GET SINGLE PRODUCT ================= */
router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const productData = await Product.findByPk(req.params.id);
    if (!productData || !productData.isActive) {
      return res.status(404).json({ msg: "Product not found" });
    }

    const product = productData.toJSON();
    const userType = (req.user?.userType || "TRAINEE_ENTREPRENEUR").toUpperCase();
    const price = Number(product.price || 0);
    let discPercent = 0;

    if (userType === "ENTREPRENEUR") {
      discPercent = Number(product.entrepreneurDiscount || 0);
    } else {
      discPercent = Number(product.traineeEntrepreneurDiscount || 0);
    }

    product.discountedPrice = Number((price - (price * discPercent) / 100).toFixed(2));

    res.json(product);
  } catch (err) {
    console.error("GET /api/products/:id error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/* ================= CREATE PRODUCT ================= */
// ✅ Admin only (recommended)
router.post("/", auth, (req, res) => {
  uploadProductImages(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ msg: err.message });

      const images = (req.files || []).map((f) => getPublicPath(f));

      const product = await Product.create({
        ...req.body,

        // numbers
        mrp: toNum(req.body.mrp, 0),
        price: toNum(req.body.price, 0),
        stockQty: toNum(req.body.stockQty, 0),

        // ✅ NEW fields
        entrepreneurDiscount: toNum(req.body.entrepreneurDiscount, 0),
        traineeEntrepreneurDiscount: toNum(req.body.traineeEntrepreneurDiscount, 0),

        featured: req.body.featured === "true" || req.body.featured === true,
        images,
      });

      res.status(201).json(product);
    } catch (e) {
      console.error("POST /api/products error:", e);
      res.status(500).json({ msg: "Create failed" });
    }
  });
});

/* ================= UPDATE PRODUCT ================= */
// ✅ Admin only (recommended)
router.put("/:id", auth, isAdmin, (req, res) => {
  uploadProductImages(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ msg: err.message });

      const product = await Product.findByPk(req.params.id);
      if (!product) return res.status(404).json({ msg: "Not found" });

      const newImages = (req.files || []).map((f) => getPublicPath(f));

      await product.update({
        ...req.body,

        // numbers (only if sent)
        mrp: req.body.mrp != null ? toNum(req.body.mrp, product.mrp) : product.mrp,
        price: req.body.price != null ? toNum(req.body.price, product.price) : product.price,
        stockQty: req.body.stockQty != null ? toNum(req.body.stockQty, product.stockQty) : product.stockQty,

        // ✅ NEW fields (only if sent)
        entrepreneurDiscount:
          req.body.entrepreneurDiscount != null
            ? toNum(req.body.entrepreneurDiscount, product.entrepreneurDiscount)
            : product.entrepreneurDiscount,

        traineeEntrepreneurDiscount:
          req.body.traineeEntrepreneurDiscount != null
            ? toNum(req.body.traineeEntrepreneurDiscount, product.traineeEntrepreneurDiscount)
            : product.traineeEntrepreneurDiscount,

        featured:
          req.body.featured != null
            ? req.body.featured === "true" || req.body.featured === true
            : product.featured,

        images: newImages.length ? newImages : product.images,
      });

      res.json(product);
    } catch (e) {
      console.error("PUT /api/products/:id error:", e);
      res.status(500).json({ msg: "Update failed" });
    }
  });
});

/* ================= DELETE (SOFT DELETE) ================= */
// ✅ Admin only (recommended)
router.delete("/:id", auth, isAdmin, async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id);
    if (!product) return res.status(404).json({ msg: "Not found" });

    product.isActive = false;
    await product.save();

    res.json({ msg: "Product hidden" });
  } catch (err) {
    console.error("DELETE /api/products/:id error:", err);
    res.status(500).json({ msg: "Delete failed" });
  }
});

export default router;

