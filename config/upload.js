import "dotenv/config"; // ✅ IMPORTANT (loads .env before using process.env)

import multer from "multer";
import fs from "fs";
import path from "path";

const ROOT =
  (process.env.UPLOAD_ROOT && process.env.UPLOAD_ROOT.trim()) ||
  path.join(process.env.HOME || process.cwd(), "persistent_uploads"); // fallback

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

export const UPLOAD_ROOT = ROOT;

const getPublicPath = (file) => {
  if (!file || !file.path) return null;
  // Hostinger/Linux uses forward slash, but node's path.relative handles it.
  // We force forward slashes for the URL stored in DB.
  const relative = path.relative(ROOT, file.path).split(path.sep).join("/");
  return `/uploads/${relative}`;
};

export { getPublicPath };


const productDir = path.join(ROOT, "products");
const profileDir = path.join(ROOT, "profilePics");
const categoryDir = path.join(ROOT, "categories");
const subCategoryDir = path.join(ROOT, "subcategories");
const bannerDir = path.join(ROOT, "banners");
const kycDir = path.join(ROOT, "kyc");

[productDir, profileDir, categoryDir, subCategoryDir, bannerDir, kycDir].forEach(ensureDir);

const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);

const fileFilter = (req, file, cb) => {
  if (!allowed.has(file.mimetype)) return cb(new Error("Only jpg, png, webp allowed"));
  cb(null, true);
};

const filename = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
};

const makeStorage = (dir) =>
  multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename,
  });

export const uploadProductImages = multer({
  storage: makeStorage(productDir),
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
}).array("images", 4);

export const uploadProfilePic = multer({
  storage: makeStorage(profileDir),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}).single("profilePic");

export const uploadCategoryImage = multer({
  storage: makeStorage(categoryDir),
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
}).single("image");

export const uploadSubCategoryImage = multer({
  storage: makeStorage(subCategoryDir),
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
}).single("image");

export const uploadBannerImage = multer({
  storage: makeStorage(bannerDir),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    cb(new Error("Only images are allowed"));
  },
  limits: { fileSize: 3 * 1024 * 1024 },
}).single("image");

export const uploadUserDocs = multer({
  storage: makeStorage(kycDir),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}).fields([
  { name: "profilePic", maxCount: 1 },
  { name: "bankPhoto", maxCount: 1 },
  { name: "panPhoto", maxCount: 1 },
  { name: "aadharPhoto", maxCount: 1 },
]);