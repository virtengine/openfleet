/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – MUI Material Design Wrapper
 *  Provides themed MUI components compatible with Preact + HTM.
 *  All MUI imports flow through this module for tree-shakeability.
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import htm from "htm";
import {
  createTheme as createMuiTheme,
  ThemeProvider as MuiThemeProvider,
  SvgIcon as MuiSvgIcon,
} from "@mui/material";

const html = htm.bind(h);

// Re-export everything apps need from @mui/material
export {
  // Theme / styling
  ThemeProvider,
  createTheme,
  styled,
  useTheme,
  alpha,
  // Layout
  Box,
  Container,
  Stack,
  Grid,
  Paper,
  // Inputs
  Button,
  IconButton,
  ButtonGroup,
  TextField,
  Select,
  MenuItem,
  Checkbox,
  Radio,
  RadioGroup,
  FormControl,
  FormControlLabel,
  FormLabel,
  FormGroup,
  FormHelperText,
  InputLabel,
  InputAdornment,
  OutlinedInput,
  Switch,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Autocomplete,
  Rating,
  // Data display
  Avatar,
  AvatarGroup,
  Badge,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemAvatar,
  ListItemButton,
  ListItemIcon,
  ListItemSecondaryAction,
  ListItemText,
  ListSubheader,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Tooltip,
  Typography,
  // Feedback
  Alert,
  AlertTitle,
  Backdrop,
  CircularProgress,
  LinearProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Skeleton,
  Snackbar,
  // Surfaces
  Accordion,
  AccordionSummary,
  AccordionDetails,
  AccordionActions,
  AppBar,
  Toolbar,
  Card,
  CardHeader,
  CardContent,
  CardActions,
  CardActionArea,
  CardMedia,
  // Navigation
  BottomNavigation,
  BottomNavigationAction,
  Breadcrumbs,
  Drawer,
  Link,
  Menu,
  Collapse,
  Pagination,
  SpeedDial,
  SpeedDialAction,
  SpeedDialIcon,
  Step,
  StepLabel,
  Stepper,
  Tab,
  Tabs,
  // Utils
  ClickAwayListener,
  CssBaseline,
  Modal,
  Popover,
  Popper,
  Portal,
  Fade,
  Grow,
  Slide,
  Zoom,
  Fab,
  SvgIcon,
  // Colors
  colors,
} from "@mui/material";

/**
 * VirtEngine dark theme — matches the existing CSS custom properties.
 * Uses Bosun brand colors (#da7756 primary, warm dark palette).
 */
export const veTheme = createMuiTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#da7756",
      light: "#e5886a",
      dark: "#c66a4d",
      contrastText: "#1e1d1a",
    },
    secondary: {
      main: "#3b82f6",
      light: "#60a5fa",
      dark: "#2563eb",
    },
    error: {
      main: "#e5534b",
    },
    warning: {
      main: "#f59e0b",
    },
    success: {
      main: "#22c55e",
    },
    info: {
      main: "#3b82f6",
    },
    background: {
      default: "#1f1e1c",
      paper: "#2b2a27",
    },
    text: {
      primary: "#e8e5de",
      secondary: "#b5b0a6",
      disabled: "#908b81",
    },
    divider: "rgba(255, 255, 255, 0.08)",
    action: {
      active: "#b5b0a6",
      hover: "rgba(255, 255, 255, 0.05)",
      selected: "rgba(218, 119, 86, 0.18)",
      disabled: "rgba(255, 255, 255, 0.26)",
      disabledBackground: "rgba(255, 255, 255, 0.08)",
    },
  },
  typography: {
    fontFamily:
      '"Instrument Sans", "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "IBM Plex Sans", "Segoe UI", sans-serif',
    fontSize: 13,
    h1: { fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em" },
    h2: { fontSize: "1.4rem", fontWeight: 700, letterSpacing: "-0.02em" },
    h3: { fontSize: "1.15rem", fontWeight: 600, letterSpacing: "-0.01em" },
    h4: { fontSize: "1rem", fontWeight: 600 },
    h5: { fontSize: "0.9rem", fontWeight: 600 },
    h6: { fontSize: "0.8rem", fontWeight: 600 },
    body1: { fontSize: "0.875rem", lineHeight: 1.6 },
    body2: { fontSize: "0.8125rem", lineHeight: 1.5 },
    caption: { fontSize: "0.75rem", color: "#908b81" },
    button: { textTransform: "none", fontWeight: 500 },
    overline: { fontSize: "0.65rem", fontWeight: 600, letterSpacing: "0.05em" },
  },
  shape: {
    borderRadius: 6,
  },
  shadows: [
    "none",
    "0 1px 2px rgba(5,10,18,0.35)",
    "0 2px 4px rgba(5,10,18,0.3)",
    "0 4px 8px rgba(5,10,18,0.28)",
    "0 6px 16px rgba(5,10,18,0.28)",
    "0 8px 20px rgba(5,10,18,0.3)",
    "0 12px 28px rgba(5,10,18,0.32)",
    "0 14px 32px rgba(5,10,18,0.32)",
    "0 16px 36px rgba(5,10,18,0.34)",
    "0 18px 40px rgba(5,10,18,0.34)",
    "0 20px 48px rgba(5,10,18,0.38)",
    ...Array(14).fill("0 20px 48px rgba(5,10,18,0.38)"),
  ],
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          scrollbarColor: "rgba(255,255,255,0.12) transparent",
          "&::-webkit-scrollbar": { width: 6 },
          "&::-webkit-scrollbar-thumb": {
            background: "rgba(255,255,255,0.12)",
            borderRadius: 3,
          },
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true, size: "small" },
      styleOverrides: {
        root: {
          borderRadius: 6,
          textTransform: "none",
          fontWeight: 500,
          fontSize: "0.8125rem",
          lineHeight: 1.4,
          padding: "6px 14px",
        },
        sizeSmall: { padding: "4px 10px", fontSize: "0.75rem" },
        containedPrimary: {
          "&:hover": { backgroundColor: "#e5886a" },
        },
      },
    },
    MuiIconButton: {
      defaultProps: { size: "small" },
      styleOverrides: {
        root: { borderRadius: 6, color: "#b5b0a6" },
        sizeSmall: { padding: 4 },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: "#2b2a27",
          border: "1px solid rgba(255,255,255,0.06)",
        },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: "#2b2a27",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 8,
        },
      },
    },
    MuiChip: {
      defaultProps: { size: "small" },
      styleOverrides: {
        root: { fontWeight: 500, fontSize: "0.7rem", height: 22 },
        sizeSmall: { height: 20 },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundImage: "none",
          backgroundColor: "#2b2a27",
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.1)",
        },
      },
    },
    MuiTooltip: {
      defaultProps: { arrow: true, enterDelay: 400 },
      styleOverrides: {
        tooltip: {
          backgroundColor: "#1f1e1c",
          border: "1px solid rgba(255,255,255,0.1)",
          fontSize: "0.75rem",
        },
        arrow: { color: "#1f1e1c" },
      },
    },
    MuiTextField: {
      defaultProps: { size: "small", variant: "outlined" },
      styleOverrides: {
        root: {
          "& .MuiOutlinedInput-root": {
            fontSize: "0.8125rem",
            borderRadius: 6,
            "& fieldset": {
              borderColor: "rgba(255,255,255,0.1)",
            },
            "&:hover fieldset": {
              borderColor: "rgba(255,255,255,0.2)",
            },
          },
        },
      },
    },
    MuiSelect: {
      defaultProps: { size: "small" },
    },
    MuiSwitch: {
      defaultProps: { size: "small" },
    },
    MuiAccordion: {
      defaultProps: { disableGutters: true, elevation: 0 },
      styleOverrides: {
        root: {
          backgroundColor: "transparent",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: "6px !important",
          "&:before": { display: "none" },
          "&.Mui-expanded": { margin: 0 },
        },
      },
    },
    MuiAccordionSummary: {
      styleOverrides: {
        root: {
          minHeight: 40,
          padding: "0 12px",
          fontSize: "0.8125rem",
          fontWeight: 500,
          "&.Mui-expanded": { minHeight: 40 },
        },
        content: { margin: "8px 0", "&.Mui-expanded": { margin: "8px 0" } },
      },
    },
    MuiAccordionDetails: {
      styleOverrides: {
        root: { padding: "4px 12px 12px" },
      },
    },
    MuiList: {
      styleOverrides: {
        root: { padding: 0 },
      },
    },
    MuiListItem: {
      styleOverrides: {
        root: { padding: "4px 12px" },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          padding: "6px 12px",
          "&.Mui-selected": {
            backgroundColor: "rgba(218,119,86,0.15)",
            "&:hover": { backgroundColor: "rgba(218,119,86,0.22)" },
          },
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: { borderColor: "rgba(255,255,255,0.08)" },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 8, fontSize: "0.8125rem" },
      },
    },
    MuiSnackbar: {
      defaultProps: {
        anchorOrigin: { vertical: "bottom", horizontal: "center" },
        autoHideDuration: 4000,
      },
    },
    MuiSkeleton: {
      defaultProps: { animation: "wave" },
      styleOverrides: {
        root: { backgroundColor: "rgba(255,255,255,0.06)" },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 500,
          fontSize: "0.8125rem",
          minHeight: 40,
          padding: "8px 14px",
          color: "#e8e5de",
          opacity: 0.95,
          // Ensure icon always sits beside label (iconPosition="start")
          flexDirection: "row",
          gap: 8,
          "&.Mui-selected": {
            color: "#da7756",
            opacity: 1,
          },
          "&:hover": {
            opacity: 1,
          },
          "& .MuiTab-iconWrapper": { marginBottom: "0 !important", marginRight: 0 },
        },
        // Constrain raw SVG icons (ICONS map returns unwrapped <svg> nodes)
        iconWrapper: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          width: 20,
          height: 20,
          "& svg": { width: "100%", height: "100%" },
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: { minHeight: 40 },
        indicator: {
          backgroundColor: "#da7756",
          height: 2,
        },
      },
    },
    MuiBottomNavigationAction: {
      styleOverrides: {
        root: {
          // Constrain raw SVG icons (ICONS map returns unwrapped <svg> nodes)
          "& svg": { width: 24, height: 24, flexShrink: 0 },
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          backgroundColor: "#23221f",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          fontSize: "0.8125rem",
          borderRadius: 6,
          margin: "2px 4px",
          padding: "6px 12px",
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { borderRadius: 4, height: 6 },
        bar: { borderRadius: 4 },
      },
    },
    MuiCircularProgress: {
      defaultProps: { size: 20, thickness: 3 },
    },
    MuiAvatar: {
      styleOverrides: {
        root: {
          fontSize: "0.8125rem",
          fontWeight: 600,
          backgroundColor: "#da7756",
          color: "#1e1d1a",
        },
      },
    },
    MuiBadge: {
      styleOverrides: {
        badge: { fontSize: "0.65rem", fontWeight: 600 },
      },
    },
    MuiFab: {
      defaultProps: { size: "small" },
      styleOverrides: {
        root: { boxShadow: "0 4px 12px rgba(0,0,0,0.3)" },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: "#1f1e1c",
          borderColor: "rgba(255,255,255,0.06)",
        },
      },
    },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: "inherit" },
      styleOverrides: {
        root: {
          backgroundColor: "#1f1e1c",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        },
      },
    },
  },
});

/**
 * Wrap content in the VirtEngine MUI theme.
 * Usage in htm: html`<${VeTheme}> ...children... </${VeTheme}>`
 */
export function VeTheme({ children }) {
  return html`<${MuiThemeProvider} theme=${veTheme}>${children}</${MuiThemeProvider}>`;
}

/**
 * Helper: MUI-styled icon wrapper for SVG icon elements.
 * Wraps an existing inline SVG in MUI SvgIcon for consistency.
 */
export function MuiIcon({ children, ...props }) {
  return html`<${MuiSvgIcon} ...${props} sx=${{ fontSize: "inherit", ...props.sx }}>${children}</${MuiSvgIcon}>`;
}
