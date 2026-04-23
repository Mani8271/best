import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const Product = sequelize.define(
  "Product",
  {
    // UI Title
    name: { type: DataTypes.STRING(200), allowNull: false },

    // Brand name (display)
    brand: { type: DataTypes.STRING(200), allowNull: true },

    // Actual manufacturer
    manufacturer: { type: DataTypes.STRING(200), allowNull: true },

    // "Strip of 30 Units", "Bottle of 150ml"
    packSize: { type: DataTypes.STRING(100), allowNull: true },

    // For search/filter later
    categoryName: { type: DataTypes.STRING(120), allowNull: false },
    subCategoryName: { type: DataTypes.STRING(120), allowNull: true },



    description: { type: DataTypes.TEXT, allowNull: true },

    // Pricing
    mrp: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },

    // Stock
    stockQty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // Show on homepage / carousel
    featured: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    entrepreneurDiscount: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0.0, // percentage
    },

    traineeEntrepreneurDiscount: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0.0, // percentage
    },

    // UI badge like "Popular ✨", "New Arrival"
    badge: {
      type: DataTypes.ENUM(
        "POPULAR",
        "NEW_ARRIVAL",
        "BEST_SELLER",
        "TRENDING",
        "LIMITED_OFFER"
      ),
      allowNull: true,
    },

    // store local image URLs (max 4)
    images: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },

    // 0/1 active for hide/show product
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    timestamps: true,
    indexes: [
      { fields: ["isActive"] },
      { fields: ["categoryName"] },
      { fields: ["subCategoryName"] },
      { fields: ["featured"] },
      { fields: ["price"] },
      { fields: ["createdAt"] },
    ],
  }
);

export default Product;
