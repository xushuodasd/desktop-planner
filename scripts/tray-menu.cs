using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public sealed class WorkboardTrayMenu : ContextMenuStrip
{
    private readonly Font menuFont;
    private float scale = 1f;

    public WorkboardTrayMenu()
    {
        ShowImageMargin = false;
        ShowCheckMargin = false;
        menuFont = new Font(SystemFonts.MenuFont.FontFamily, 10.5f);
        Font = menuFont;
        Renderer = new WorkboardRenderer(this);
    }

    public ToolStripMenuItem AddAction(string text, string icon)
    {
        var item = new ToolStripMenuItem(text) { AutoSize = false, Tag = icon, Margin = Padding.Empty };
        Items.Add(item);
        ApplySize(item);
        return item;
    }

    protected override void OnOpening(CancelEventArgs e)
    {
        using (Graphics graphics = CreateGraphics())
            scale = graphics.DpiX / 96f;
        Padding = new Padding(Px(6));
        MinimumSize = new Size(Px(176), 0);
        foreach (ToolStripItem item in Items)
            ApplySize(item);
        base.OnOpening(e);
        PerformLayout();
        UpdateCorners();
    }

    private void ApplySize(ToolStripItem item)
    {
        item.AutoSize = false;
        item.Size = new Size(Px(172), Px(item is ToolStripSeparator ? 9 : 36));
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        UpdateCorners();
    }

    private void UpdateCorners()
    {
        if (Width <= Px(24) || Height <= Px(24)) return;
        Region previous = Region;
        using (GraphicsPath path = Rounded(new Rectangle(0, 0, Width, Height), Px(12)))
            Region = new Region(path);
        if (previous != null) previous.Dispose();
    }

    private int Px(int value) { return (int)Math.Round(value * scale); }

    private static GraphicsPath Rounded(Rectangle rect, int radius)
    {
        var path = new GraphicsPath();
        int diameter = radius * 2;
        path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
        path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
        path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && menuFont != null) menuFont.Dispose();
    }

    private sealed class WorkboardRenderer : ToolStripRenderer
    {
        private static readonly Color SurfaceTop = Color.FromArgb(37, 49, 70);
        private static readonly Color SurfaceBottom = Color.FromArgb(24, 33, 50);
        private static readonly Color Border = Color.FromArgb(64, 78, 103);
        private static readonly Color Ink = Color.FromArgb(244, 247, 253);
        private static readonly Color Glyph = Color.FromArgb(177, 201, 235);
        private static readonly Color Hover = Color.FromArgb(54, 72, 104);
        private readonly WorkboardTrayMenu menu;

        public WorkboardRenderer(WorkboardTrayMenu menu) { this.menu = menu; }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
        {
            Rectangle area = e.ToolStrip.ClientRectangle;
            using (var brush = new LinearGradientBrush(area, SurfaceTop, SurfaceBottom, LinearGradientMode.Vertical))
                e.Graphics.FillRectangle(brush, area);
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            var area = new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var outline = Rounded(area, menu.Px(12)))
            using (var edge = new Pen(Border))
                e.Graphics.DrawPath(edge, outline);
        }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            GraphicsState state = e.Graphics.Save();
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            if (e.Item.Selected)
            {
                int inset = menu.Px(6);
                var area = new Rectangle(inset, menu.Px(1), e.Item.Width - inset * 2, e.Item.Height - menu.Px(2));
                using (var shape = Rounded(area, menu.Px(7)))
                using (var brush = new SolidBrush(Hover))
                    e.Graphics.FillPath(brush, shape);
            }
            e.Graphics.TranslateTransform(menu.Px(13), (e.Item.Height - menu.Px(18)) / 2f);
            e.Graphics.ScaleTransform(menu.scale, menu.scale);
            using (var pen = new Pen(Glyph, 1.35f))
            {
                pen.StartCap = pen.EndCap = LineCap.Round;
                DrawGlyph(e.Graphics, pen, e.Item.Tag as string);
            }
            e.Graphics.Restore(state);
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            int left = menu.Px(42);
            var area = new Rectangle(left, 0, e.Item.Width - left - menu.Px(10), e.Item.Height);
            TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, area, Ink,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine |
                TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis | TextFormatFlags.PreserveGraphicsClipping);
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            int y = e.Item.Height / 2;
            using (var pen = new Pen(Border))
                e.Graphics.DrawLine(pen, menu.Px(10), y, e.Item.Width - menu.Px(10), y);
        }

        private static void DrawGlyph(Graphics g, Pen pen, string icon)
        {
            switch (icon)
            {
                case "panel":
                    using (var outline = Rounded(new Rectangle(2, 3, 14, 12), 2))
                        g.DrawPath(pen, outline);
                    g.DrawLine(pen, 6, 3, 6, 15);
                    break;
                case "review":
                    g.DrawEllipse(pen, 2, 2, 14, 14);
                    g.DrawLines(pen, new[] { new Point(9, 5), new Point(9, 9), new Point(12, 11) });
                    break;
                case "settings":
                    g.DrawLine(pen, 2, 5, 16, 5);
                    g.DrawLine(pen, 2, 13, 16, 13);
                    g.DrawLine(pen, 6, 3, 6, 7);
                    g.DrawLine(pen, 12, 11, 12, 15);
                    break;
                case "quit":
                    g.DrawArc(pen, 2.5f, 3, 13, 13, -50, 280);
                    g.DrawLine(pen, 9, 1.5f, 9, 8);
                    break;
            }
        }
    }
}
