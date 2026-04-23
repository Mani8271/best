import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const SubCategory = sequelize.define(
  "SubCategory",
  {
    categoryId: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    
    image: { type: DataTypes.STRING(255), allowNull: true },
  },
  {
    timestamps: true,
    indexes: [{ unique: true, fields: ["categoryId", "name"] }],
  }
);

export default SubCategory;
