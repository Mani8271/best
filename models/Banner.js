// models/Banner.js
import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const Banner = sequelize.define(
  "Banner",
  {
    title: { type: DataTypes.STRING, allowNull: true },
    subtitle: { type: DataTypes.STRING, allowNull: true },

    // image path like "/uploads/banners/xxx.jpg"
    image: { type: DataTypes.STRING, allowNull: false },

    // where to go when click
    linkUrl: { type: DataTypes.STRING, allowNull: true },

    // HOME_TOP, HOME_MIDDLE, PRODUCTS_TOP, etc.
    placement: { type: DataTypes.STRING, allowNull: false, defaultValue: "HOME_TOP" },

    // SLIDER or CAROUSEL (optional)
    type: { type: DataTypes.STRING, allowNull: false, defaultValue: "SLIDER" },

    // sort order in that placement
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // show/hide
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // optional schedule
    startsAt: { type: DataTypes.DATE, allowNull: true },
    endsAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "banners" }
);

export default Banner;
